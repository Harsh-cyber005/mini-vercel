"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Github } from "lucide-react";
import { Fira_Code } from "next/font/google";
import axios from "axios";
const firaCode = Fira_Code({ subsets: ["latin"] });
export default function Home() {
  const [repoURL, setURL] = useState<string>("");
  const [projectName, setProjectName] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [deployPreviewURL, setDeployPreviewURL] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const isValidURL: [boolean, string | null] = useMemo(() => {
    if (!repoURL.trim()) return [false, null];
    const regex = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/]+)\/([^\/]+)(?:\/)?$/;
    if (!regex.test(repoURL)) return [false, "Enter a valid Github Repository URL"];
    return [true, null];
  }, [repoURL]);
  // Initialize socket once
  useEffect(() => {
    socketRef.current = io("http://localhost:9002");
    socketRef.current.on("message", (message: string) => {
      try {
        const { log } = JSON.parse(message);
        setLogs((prev) => {
          // Limit to last 200 logs max
          const newLogs = [...prev, log];
          return newLogs.length > 200 ? newLogs.slice(newLogs.length - 200) : newLogs;
        });
        // Scroll to latest log
        logContainerRef.current?.scrollIntoView({ behavior: "smooth" });
      } catch {
        // Ignore bad message formats
      }
    });
    return () => {
      socketRef.current?.disconnect();
    };
  }, []);
  const handleClickDeploy = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.post(`http://localhost:9000/project`, {
        name: projectName.trim(),
        gitURL: repoURL.trim(),
      });
      if (data?.status === "success" && data.data?.project) {
        const projectSlug = data.data.project.subDomain || data.data.project.id;
        setProjectId(projectSlug);
        // You need to define how to generate preview URL from projectSlug
        const previewURL = `https://${projectSlug}.yourdomain.com`; // adjust accordingly
        setDeployPreviewURL(previewURL);
        console.log(`Subscribing to logs: ${projectSlug}`);
        socketRef.current?.emit("subscribe", `logs:${projectSlug}`);
      } else {
        setError("Unexpected response from server.");
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || "Deployment failed.");
    } finally {
      setLoading(false);
    }
  }, [repoURL, projectName]);
  return (
    <main className="flex justify-center items-center h-[100vh]">
      <div className="w-[600px] space-y-4">
        <span className="flex justify-start items-center gap-2">
          <Github className="text-5xl" />
          <Input
            placeholder="Project Name"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            disabled={loading}
          />
          <Input
            placeholder="Github Repository URL"
            value={repoURL}
            onChange={(e) => setURL(e.target.value)}
            type="url"
            disabled={loading}
          />
        </span>
        {error && <p className="text-red-500">{error}</p>}
        <Button
          onClick={handleClickDeploy}
          disabled={!isValidURL[0] || !projectName.trim() || loading}
          className="w-full"
        >
          {loading ? "In Progress..." : "Deploy"}
        </Button>
        {deployPreviewURL && (
          <div className="mt-2 bg-slate-900 py-4 px-2 rounded-lg">
            <p>
              Preview URL:{" "}
              <a
                target="_blank"
                rel="noopener noreferrer"
                className="text-sky-400 bg-sky-950 px-3 py-2 rounded-lg"
                href={deployPreviewURL}
              >
                {deployPreviewURL}
              </a>
            </p>
          </div>
        )}
        {logs.length > 0 && (
          <div
            className={`${firaCode.className} text-sm text-green-500 logs-container mt-5 border-green-500 border-2 rounded-lg p-4 h-[300px] overflow-y-auto`}
          >
            <pre className="flex flex-col gap-1">
              {logs.map((log, i) => (
                <code
                  key={i}
                  ref={logs.length - 1 === i ? logContainerRef : undefined}
                >
                  {`> ${log}`}
                </code>
              ))}
            </pre>
          </div>
        )}
      </div>
    </main>
  );
}
