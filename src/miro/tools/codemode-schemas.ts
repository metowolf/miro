import type { JsonSchema } from "./types.ts";

const string = { type: "string" };
const boolean = { type: "boolean" };
const integer = { type: "integer" };
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

/** 脚本总是收到同一封装；data 才是工具的程序化结果，output 保留展示文本。 */
export function codemodeOutputSchema(name: string): JsonSchema {
  let data: JsonSchema = {};
  if (name === "read_file") data = object({
    path: string, content: string, offset: integer, lineCount: integer,
    nextOffset: { anyOf: [integer, { type: "null" }] }, truncated: boolean,
  });
  if (name === "glob") data = object({ path: string, paths: { type: "array", items: string }, truncated: boolean });
  if (name === "grep") data = object({
    path: string, matches: { type: "array", items: object({ path: string, line: integer, text: string, truncated: boolean }) },
    truncated: boolean, skippedFiles: integer,
  });
  return object({ output: string, data });
}
