// src/lib/mcp.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { tool, StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

let mcpClient: Client | null = null;

export async function getMcpClient(): Promise<Client> {
  if (mcpClient) return mcpClient;

  const url = process.env.MCP_SERVER_URL || "http://localhost:3001/mcp";
  const transport = new StreamableHTTPClientTransport(new URL(url));

  const client = new Client(
    {
      name: "ai-fin-assistant-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  // Use a type cast to the interface since the SDK classes might have strict property 
  // differences with exactOptionalPropertyTypes enabled.
  await client.connect(transport as Transport);
  mcpClient = client;
  return mcpClient;
}

export async function getMcpTools(): Promise<StructuredTool[]> {
  const client = await getMcpClient();
  const { tools } = await client.listTools();

  return tools.map((toolInfo) => {
    return tool(
      async (args) => {
        console.log(`🛠️ Calling Tool [${toolInfo.name}] with args:`, args);
        const result = await client.callTool({
          name: toolInfo.name,
          arguments: args as Record<string, unknown>,
        });
        console.log(`📦 Tool [${toolInfo.name}] Response:`, JSON.stringify(result).substring(0, 500));

        if (result.content && Array.isArray(result.content)) {
          return result.content
            .map((c) => {
              if (c.type === "text") {
                return c.text;
              }
              return JSON.stringify(c);
            })
            .join("\n");
        }
        return JSON.stringify(result);
      },
      {
        name: toolInfo.name,
        description: toolInfo.description || "",
        schema: z.record(z.string(), z.unknown()),
      }
    );
  });
}
