import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { compactHistory, agentInstructions, taskMessage } from "./index.js";
import { contextLimit, taskContextParts, type ContextSource } from "./context.js";
import { toolNames } from "../tools/schema.js";
import { maxRecommendedBytes } from "../config/models.js";
import type { Call, Message, Model } from "../model/types.js";
import type { Tools } from "../tools/index.js";

type Hooks = { before(call: Call, signal: AbortSignal): Promise<string | undefined>; after(call: Call, result: string, signal: AbortSignal): Promise<string> };
type Activity = { step: number; phase: "start" | "finish"; tool: string; path?: string; detail?: string; result?: string };

/**
 * Runs one task with Stellan-Host's native agent loop (`stellan-host --agent`). The app still supplies the model
 * replies (unless Host calls the engine itself), runs every tool through its own approval cards, runs hooks when
 * Host asks, and runs Max for delegate_code; Host decides when, with the same rules as runAgent and createDelegate.
 */
export async function runAgentOnHost(host: string, options: {
  task: string; messages: Message[]; model: Model; tools: Pick<Tools, "execute">; maxSteps: number;
  extraInstructions?: string; hooks?: Hooks | undefined; historyBytes?: number | undefined; taskInstructions?: string;
  activity?: (event: Activity) => void; specialist?: { totalBytes: number; noSwap: boolean; available?: boolean; code?: (task: string, context: string, signal: AbortSignal) => Promise<string> };
  context?: { source: ContextSource; maxBytes?: number }; signal: AbortSignal;
  emit: (text: string, thinking: boolean) => void; log: (text: string) => void; save: (batch: Message[]) => Promise<void>;
  /** When given, Host calls Stellan-Run itself with this request (no model replies pass through Node). */
  engine?: { port: number; key: string; options: Record<string, unknown>; historyBytes: number; onThinking?: () => void; onUsage?: (tokens: number) => void };
}): Promise<"finished" | "limit"> {
  const { messages, model, tools, signal, hooks } = options;
  const project = options.context ? await taskContextParts(options.task, options.context.source, options.context.maxBytes, signal) : { list: "", named: "" };
  const specialist = options.specialist;
  const available = Boolean(specialist?.available && specialist.code);
  const paired = available && !specialist!.noSwap && specialist!.totalBytes >= maxRecommendedBytes;
  const instructions = agentInstructions(options.extraInstructions ?? "", paired);
  const budget = options.historyBytes ?? contextLimit();
  // Compacting first keeps taskMessage's "list already sent" memory right; Host's own compaction then has nothing to do.
  const compacted = compactHistory(messages, budget);
  if (compacted) { options.log(`Summarised ${compacted} earlier task${compacted === 1 ? "" : "s"} to keep the conversation within its memory.`); }
  const first = taskMessage(options.task, messages, project, options.taskInstructions);
  const child = spawn(host, ["--agent"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr = (stderr + text).slice(-4000); });
  const exited = new Promise<number | null>((done) => child.on("close", done));
  const stop = () => child.kill();
  signal.addEventListener("abort", stop, { once: true });
  const write = (value: unknown) => { child.stdin.write(JSON.stringify(value) + "\n"); };
  let summaryStreamed = false;
  let outcome: "finished" | "limit" | undefined;
  try {
    write({ task: first, messages, maxSteps: Number.isFinite(options.maxSteps) ? options.maxSteps : 1e15, taskInstructions: "", historyBytes: budget,
      tools: toolNames, ...(options.engine ? { engine: { port: options.engine.port, key: options.engine.key, system: instructions, options: options.engine.options, historyBytes: options.engine.historyBytes } } : {}), totalBytes: options.specialist?.totalBytes ?? 0, recommendedBytes: maxRecommendedBytes, noSwap: options.specialist?.noSwap ?? false, available, hooks: Boolean(hooks) });
    for await (const line of createInterface({ input: child.stdout })) {
      signal.throwIfAborted();
      const event = JSON.parse(line) as Record<string, unknown>;
      switch (event.event) {
        case "complete": {
          try {
            const reply = await model.complete([{ role: "system", content: instructions }, ...(event.messages as Message[])], signal, options.emit);
            summaryStreamed = reply.summaryStreamed === true;
            write({ content: reply.content });
          } catch (error) { signal.throwIfAborted(); throw error; }
          break;
        }
        case "tool": {
          const call: Call = { id: "host", type: "function", function: { name: String(event.name), arguments: String(event.arguments) } } as Call;
          try { write({ result: await tools.execute(call, signal) }); }
          catch (error) { signal.throwIfAborted(); write({ error: error instanceof Error ? error.message : String(error) }); }
          break;
        }
        case "before": {
          const call: Call = { id: "host", type: "function", function: { name: String(event.name), arguments: String(event.arguments) } } as Call;
          try { write({ blocked: (await hooks?.before(call, signal)) ?? null }); }
          catch (error) { signal.throwIfAborted(); write({ error: error instanceof Error ? error.message : String(error) }); }
          break;
        }
        case "after": {
          const call: Call = { id: "host", type: "function", function: { name: String(event.name), arguments: String(event.arguments) } } as Call;
          try { write({ notes: (await hooks?.after(call, String(event.result), signal)) ?? "" }); }
          catch (error) { signal.throwIfAborted(); write({ error: error instanceof Error ? error.message : String(error) }); }
          break;
        }
        case "code": {
          try { write({ result: await specialist!.code!(String(event.task), String(event.context), signal) }); }
          catch (error) { signal.throwIfAborted(); write({ error: error instanceof Error ? error.message : String(error) }); }
          break;
        }
        // Without an engine, Host only emits the final summary, which the stream already showed when it streamed.
        case "emit": if (options.engine || !(summaryStreamed && event.thinking === false)) { options.emit(String(event.text), event.thinking === true); } break;
        case "thinking": options.engine?.onThinking?.(); break;
        case "usage": options.engine?.onUsage?.(Number(event.tokens)); break;
        case "log": options.log(String(event.text)); break;
        case "save": { const batch = event.batch as Message[]; await options.save(batch); messages.push(...batch); break; }
        case "activity": { const { event: _kind, ...activity } = event; options.activity?.(activity as unknown as Activity); break; }
        case "done": outcome = event.outcome as "finished" | "limit"; break;
      }
    }
    signal.throwIfAborted();
    const code = await exited;
    if (!outcome || code !== 0) { throw new Error(`Stellan-Host stopped during the task${stderr ? `: ${stderr.trim()}` : ""}. Try again, or restart the app.`); }
    return outcome;
  } finally {
    signal.removeEventListener("abort", stop);
    if (child.exitCode === null) { child.kill(); }
  }
}
