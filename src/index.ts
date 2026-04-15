import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";

const authToken = process.env.MCP_AUTH_TOKEN;
if (!authToken) {
  throw new Error("MCP_AUTH_TOKEN is required");
}
const expectedToken = Buffer.from(authToken);

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const provided = Buffer.from(header.slice("Bearer ".length));
  if (provided.length !== expectedToken.length || !timingSafeEqual(provided, expectedToken)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "personal-mcp", version: "0.1.0" });
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Health check tool. Returns pong with the current server time.",
      inputSchema: { message: z.string().optional() },
    },
    async ({ message }) => ({
      content: [
        {
          type: "text",
          text: `pong${message ? ` (${message})` : ""} @ ${new Date().toISOString()}`,
        },
      ],
    }),
  );
  return server;
}

const app = express();
app.use(express.json());
app.use("/mcp", requireAuth);

app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`personal-mcp listening on http://localhost:${port}/mcp`);
});
