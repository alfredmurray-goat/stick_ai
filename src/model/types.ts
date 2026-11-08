export interface Call {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Call[];
  tool_call_id?: string;
}
export interface Reply { content: string; calls: Call[]; summaryStreamed?: boolean }
export interface Model {
  complete(messages: Message[], signal: AbortSignal, emit: (text: string, thinking: boolean) => void): Promise<Reply>;
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
