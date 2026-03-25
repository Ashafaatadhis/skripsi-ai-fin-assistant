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
    },
  );

  await client.connect(transport as Transport);
  mcpClient = client;
  return mcpClient;
}

/**
 * PRO TIP: Fungsi ini mengubah JSON Schema dari MCP Server 
 * menjadi Zod Schema secara dinamis. 
 * Jadi kita tidak perlu menulis ulang Zod di sisi asisten!
 */
function createDynamicZodSchema(inputSchema: any): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};

  if (inputSchema.type === "object" && inputSchema.properties) {
    for (const [key, value] of Object.entries<any>(inputSchema.properties)) {
      let validator: z.ZodTypeAny;

      // Fungsi helper untuk mapping tipe data JSON Schema ke Zod
      const mapType = (jsonType: any): z.ZodTypeAny => {
        switch (jsonType.type) {
          case "string":
            return z.string();
          case "number":
            return z.number();
          case "integer":
            return z.number().int();
          case "boolean":
            return z.boolean();
          case "array":
            // Jika ada info tipe di dalam array (items), kita petakan secara rekursif
            if (jsonType.items) {
              return z.array(mapType(jsonType.items));
            }
            return z.array(z.any());
          case "object":
            if (jsonType.properties) {
              return createDynamicZodSchema(jsonType);
            }
            return z.record(z.string(), z.unknown());
          default:
            return z.unknown();
        }
      };

      validator = mapType(value);

      // Tambahkan deskripsi agar AI makin paham
      if (value.description) {
        validator = (validator as any).describe(value.description);
      }

      // Cek apakah field ini opsional
      const isRequired = inputSchema.required?.includes(key);
      shape[key] = isRequired ? validator : validator.optional();
    }
  }

  return z.object(shape);
}

export async function getMcpTools(): Promise<StructuredTool[]> {
  const client = await getMcpClient();
  const { tools } = await client.listTools();

  return tools.map((toolInfo) => {
    // OTOMATIS: Ambil skema langsung dari server
    const dynamicSchema = createDynamicZodSchema(toolInfo.inputSchema);
    console.log(`📡 Registered Dynamic Tool: [${toolInfo.name}]`, JSON.stringify(toolInfo.inputSchema));

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
            .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        }
        return JSON.stringify(result);
      },
      {
        name: toolInfo.name,
        description: toolInfo.description || "",
        schema: dynamicSchema, // Gunakan skema dinamis
      },
    );
  });
}
