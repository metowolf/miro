/** 工具边界允许供应方扩展 JSON Schema，但执行器返回值采用统一契约。 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  [keyword: string]: any;
}

export interface ToolDefinition {
  name: string;
  kind: string;
  title: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolResult {
  output?: string;
  error?: string;
  content?: any[];
  failed?: boolean;
  rawOutput?: { stdout: string; stderr: string };
  stopTurn?: boolean;
  transition?: { type: string; [key: string]: any };
  [key: string]: any;
}

export type ToolRunner = (input: any, context?: any) => Promise<ToolResult>;
