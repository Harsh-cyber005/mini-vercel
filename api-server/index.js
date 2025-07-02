const express = require('express')
const { generateSlug } = require('random-word-slugs')
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs')
const { Server } = require('socket.io')
const cors = require('cors')
const { z } = require('zod')
const { PrismaClient } = require('@prisma/client')
const { createClient } = require('@clickhouse/client')
const { Kafka } = require('kafkajs')
const { v4: uuidv4 } = require('uuid')
require('dotenv').config()
if (!process.env.KAFKA_BROKER || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.error('Missing required environment variables.')
    process.exit(1)
}
const app = express()
const PORT = 9000
const prisma = new PrismaClient()
const io = new Server({ cors: '*' })
const kafka = new Kafka({
    clientId: `docker-build-server`,
    brokers: [process.env.KAFKA_BROKER],
})
const client = createClient({
    host: 'http://localhost:8123',
    database: 'default',
    username: 'default',
    password: ''
})
const consumer = kafka.consumer({ groupId: 'api-server-logs-consumer' })
io.on('connection', socket => {
    socket.on('subscribe', channel => {
        socket.join(channel)
        socket.emit('message', JSON.stringify({ log: `Subscribed to ${channel}` }))
    })
})
io.listen(9002, () => console.log('Socket Server 9002'))
const ecsClient = new ECSClient({
    region: 'ap-south-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
})
const config = {
    CLUSTER: process.env.CLUSTER,
    TASK: process.env.TASK
}
app.use(express.json())
app.use(cors())
app.post('/project', async (req, res) => {
    const schema = z.object({
        name: z.string(),
        gitURL: z.string()
    })
    const safeParseResult = schema.safeParse(req.body)
    if (safeParseResult.error) return res.status(400).json({ error: safeParseResult.error })
    const { name, gitURL } = safeParseResult.data
    const project = await prisma.project.create({
        data: {
            name,
            gitURL,
            subDomain: generateSlug()
        }
    })
    return res.json({ status: 'success', data: { project } })
})
app.post('/deploy', async (req, res) => {
    const { projectId } = req.body
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) return res.status(404).json({ error: 'Project not found' })
    const deployment = await prisma.deployement.create({
        data: {
            project: { connect: { id: projectId } },
            status: 'QUEUED'
        }
    })
    const command = new RunTaskCommand({
        cluster: config.CLUSTER,
        taskDefinition: config.TASK,
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
            awsvpcConfiguration: {
                assignPublicIp: 'ENABLED',
                subnets: [process.env.SUBNET_1, process.env.SUBNET_2, process.env.SUBNET_3],
                securityGroups: [process.env.SECURITY_GROUP]
            }
        },
        overrides: {
            containerOverrides: [
                {
                    name: 'build-server-img',
                    environment: [
                        { name: 'GIT_REPOSITORY__URL', value: project.gitURL },
                        { name: 'PROJECT_ID', value: projectId },
                        { name: 'DEPLOYEMENT_ID', value: deployment.id }
                    ]
                }
            ]
        }
    })
    await ecsClient.send(command)
    return res.json({ status: 'queued', data: { deploymentId: deployment.id } })
})
app.get('/logs/:id', async (req, res) => {
    const id = req.params.id
    const logs = await client.query({
        query: `SELECT event_id, deployment_id, log, timestamp FROM log_events WHERE deployment_id = {deployment_id:String}`,
        query_params: {
            deployment_id: id
        },
        format: 'JSONEachRow'
    })
    const rawLogs = await logs.json()
    return res.json({ logs: rawLogs })
})
async function initKafkaConsumer() {
    await consumer.connect()
    await consumer.subscribe({ topics: ['container-logs'], fromBeginning: true })
    consumer.on(consumer.events.CRASH, async err => {
        console.error('Kafka consumer crashed:', err)
        process.exit(1)
    })
    await consumer.run({
        eachBatch: async ({ batch, heartbeat, commitOffsetsIfNecessary, resolveOffset }) => {
            const messages = batch.messages
            console.log(`Received ${messages.length} messages..`)
            for (const message of messages) {
                if (!message.value) continue
                try {
                    const stringMessage = message.value.toString()
                    const { PROJECT_ID, DEPLOYEMENT_ID, log } = JSON.parse(stringMessage)
                    console.log({ log, DEPLOYEMENT_ID })
                    const { query_id } = await client.insert({
                        table: 'log_events',
                        values: [{
                            event_id: uuidv4(),
                            deployment_id: DEPLOYEMENT_ID,
                            log
                        }],
                        format: 'JSONEachRow'
                    })
                    io.to(DEPLOYEMENT_ID).emit('message', JSON.stringify({ log }))
                    console.log('Inserted with query id:', query_id)
                    resolveOffset(message.offset)
                    await commitOffsetsIfNecessary(message.offset)
                    await heartbeat()
                } catch (err) {
                    console.error('Error in Kafka message handling:', err)
                }
            }
        }
    })
}
initKafkaConsumer()
process.on('SIGINT', async () => {
    console.log('Gracefully shutting down...')
    await consumer.disconnect()
    await prisma.$disconnect()
    process.exit(0)
})
app.listen(PORT, () => console.log(`API Server Running on ${PORT}`))
