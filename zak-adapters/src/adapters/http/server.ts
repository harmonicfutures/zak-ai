import { createServer, IncomingMessage, ServerResponse } from "http";
import { HttpZakAdapter } from "./adapter";

/**
 * Starts the Pilot Adapter Server.
 * Zero frameworks. Zero magic.
 */
export function startHttpAdapter(adapter: HttpZakAdapter, port = 8080) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 1. Health Check (GET /zak/health)
    if (req.method === "GET" && req.url === "/zak/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }

    // 2. Execution Endpoint (POST /zak/execute)
    if (req.method === "POST" && req.url === "/zak/execute") {
      let bodyString = "";
      
      req.on("data", (chunk) => {
        bodyString += chunk;
        // Basic DoS protection: kill connection if payload too large (>1MB)
        if (bodyString.length > 1e6) {
          req.destroy();
        }
      });

      req.on("end", async () => {
        try {
          const bodyJson = JSON.parse(bodyString);
          
          // A. Ingest
          const input = adapter.ingest(req.headers, bodyJson);
          
          // B. Execute
          const result = await adapter.execute(input);
          
          // C. Emit
          const output = adapter.emit(input.correlationId, result);

          res.writeHead(output.status, output.headers);
          res.end(JSON.stringify(output.body));

        } catch (err: unknown) {
          // Handle Ingest/Parse Errors
          const statusCode = (err instanceof Error && err.message.includes("Invalid")) ? 400 : 500;
          res.writeHead(statusCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ 
              error: err instanceof Error ? err.message : "Internal Server Error" 
          }));
        }
      });
      return;
    }

    // 3. 404 For Everything Else
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    console.log(`ZAK HTTP Pilot Adapter running on port ${port}`);
    console.log(`Routes: POST /zak/execute, GET /zak/health`);
  });

  return server;
}

