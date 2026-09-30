import { createInterface } from "node:readline";

/** 独立的最小协议服务，用于验证客户端的真实传输和分页。 */
export function respondMcp(message) {
  if (message.id == null) return null;
  let result;
  switch (message.method) {
    case "initialize":
      result = { protocolVersion: message.params.protocolVersion, serverInfo: { name: "miro-test", version: "1.0.0" },
        capabilities: { tools: {} } };
      break;
    case "tools/list":
      result = message.params?.cursor ? { tools: [{ name: "other", inputSchema: { type: "object" } }] } : { tools: [{
        name: "echo", description: "Echo test input",
        inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      }], nextCursor: "page-2" };
      break;
    case "tools/call":
      result = { content: [{ type: "text", text: message.params.arguments.value }], structuredContent: { value: message.params.arguments.value } };
      break;
    default:
      return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  }
  return { jsonrpc: "2.0", id: message.id, result };
}

if (import.meta.main) {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const response = respondMcp(JSON.parse(line));
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
