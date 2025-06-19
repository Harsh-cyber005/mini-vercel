const express = require("express");
const httpProxy = require("http-proxy");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const app = express();
const PORT = 8000;

const BASE_PATH = "https://harshmax-vercel-outputs.s3.ap-south-1.amazonaws.com/__outputs";
const prisma = new PrismaClient();
const proxy = httpProxy.createProxy();

proxy.on("proxyReq", (proxyReq, req, res) => {
    const url = req.url;
    if (url === "/") {
        proxyReq.path += "index.html";
    }
});

app.use(async (req, res) => {
    try {
        const hostname = req.hostname;
        const subdomain = hostname.split(".")[0];

        if (!subdomain || subdomain === "localhost") {
            return res.status(400).send("Subdomain not found in the request hostname.");
        }

        const project = await prisma.project.findUnique({
            where: { subDomain: subdomain },
            include: {
                Deployement: {
                    orderBy: { createdAt: "desc" },
                    take: 1
                }
            }
        });

        if (!project || project.Deployement.length === 0) {
            return res.status(404).send("Project or deployment not found.");
        }

        const deploymentId = project.Deployement[0].id;
        const resolvesTo = `${BASE_PATH}/${deploymentId}`;

        console.log(`Proxying "${subdomain}" to: ${resolvesTo}${req.url}`);

        const hasExtension = path.extname(req.path).length > 0;
        if (!hasExtension) {
            req.url = '/index.html';
        }

        proxy.web(req, res, { target: resolvesTo, changeOrigin: true });

    } catch (err) {
        console.error("Proxy Error:", err);
        res.status(500).send("Internal Server Error");
    }
});

app.listen(PORT, () => {
    console.log(`Reverse Proxy running on port ${PORT}`);
});
