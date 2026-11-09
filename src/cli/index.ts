#!/usr/bin/env node
import { projectContext } from "../agent/context.js";
import { coderSystem } from "../agent/delegate.js";
import { managedSession } from "../portable/cli-session.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { assertModelAllowed, pickModel, ramStatus, renderModelPicker } from "../config/models.js";
import { detectBackend } from "../sandbox/backends.js";
import { Sandbox } from "../sandbox/paths.js";
import { initConfig, loadConfig } from "../config/index.js";
import { Ollama } from "../model/ollama.js";
import { Tools } from "../tools/index.js";
import { History } from "../agent/history.js";
import { runAgent } from "../agent/index.js";
import { errorText } from "../model/types.js";

const clean = (text: string): string => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
let release: (() => Promise<void>) | undefined;
let managed: Awaited<ReturnType<typeof managedSession>> | undefined;
async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  const yes = raw.includes("--yes");
  const remote = raw.includes("--allow-remote");
  const forceMax = raw.includes("--force-max");
  const noSwap = raw.includes("--no-swap");
  const rootIndex = raw.indexOf("--stick-root");
  const stickRoot = rootIndex >= 0 ? raw[rootIndex + 1] : undefined;
  if (rootIndex >= 0 && (!stickRoot || stickRoot.startsWith("--"))) { throw new Error("--stick-root requires a USB root directory"); }
  const ram = ramStatus(undefined, forceMax);
  const args = raw.filter((arg, index) => !["--yes", "--allow-remote", "--force-max", "--no-swap", "--stick-root"].includes(arg) && (rootIndex < 0 || index !== rootIndex + 1));
  if (args.includes("--help")) { stdout.write("stick [chat | run <task> | init | doctor] [--yes] [--allow-remote] [--force-max] [--no-swap] [--stick-root <folder>]\n"); return; }
  const command = args[0] ?? "chat";
  if (!["chat", "run", "init", "doctor"].includes(command) || (command === "run" ? args.length !== 2 : args.length > 1)) { throw new Error("Usage: stick [chat | run <task> | init | doctor] [--yes] [--allow-remote] [--force-max] [--no-swap] [--stick-root <folder>]"); }
  const box = await Sandbox.create(process.cwd());
  const backend = await detectBackend(box);
  if (ram.warning) { console.error(ram.warning); }
  if (command === "init") { await initConfig(box); stdout.write("Created .stick/config.json\n"); return; }
  const config = await loadConfig(box, remote);
  if (command === "doctor") {
    stdout.write(clean(JSON.stringify({ platform: backend.platform, backend: backend.name, isolated: backend.isolated, shell: backend.shell, cwd: box.root, warning: backend.warning ?? null, ram, selectedModel: config.model, selectedModelAllowed: config.model !== "stellan-1-max" || !ram.maxLocked }, null, 2)) + "\n");
    return;
  }
  if (backend.warning) { console.error(clean(backend.warning)); }
  assertModelAllowed(config.model, ram);
  const history = new History(box);
  release = await history.lock();
  const messages = await history.load();
  const terminal = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  let active: AbortController | undefined;
  let channel: boolean | undefined;
  const interrupt = (): void => {
    if (active) { active.abort(new Error("Cancelled by Ctrl+C")); }
    stdout.write("\nCancelled. Use /exit to leave.\n");
  };
  terminal.on("SIGINT", interrupt);
  process.on("SIGINT", interrupt);
  const tools = new Tools(box, async (description, signal) => {
    if (yes) { return true; }
    if (!stdin.isTTY) { return false; }
    const answer = await terminal.question(`\nApprove ${clean(description)}? [y/N] `, { signal });
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  }, backend);
  if (stickRoot) { managed = await managedSession(stickRoot); }
  const modelClient = (selected: string) => new Ollama(selected, managed?.engine.baseUrl ?? config.baseUrl, remote, ram, { ...(managed ? { apiKey: managed.engine.key } : {}), specialist: selected === "stellan-1-max" });
  let model = modelClient(config.model);
  const execute = async (task: string): Promise<void> => {
    active = new AbortController(); channel = undefined;
    try {
      if (managed && managed.engine.active !== config.model) { await managed.engine.start(config.model, active.signal); }
      if (config.model === "stellan-1-max") {
        const reply = await model.complete([{ role: "system", content: coderSystem }, { role: "user", content: task }], active.signal, () => {});
        const batch = [{ role: "user" as const, content: task }, { role: "assistant" as const, content: reply.content }];
        await history.append(batch); messages.push(...batch); stdout.write(clean(reply.content)); return;
      }
      const status = await runAgent({
        task, messages, model, tools, context: { source: projectContext(box) },
        specialist: { totalBytes: ram.totalBytes, noSwap, available: Boolean(managed?.maxPresent && config.model === "stellan-1-lite"), code: (task, context, signal) => managed!.engine.code(task, context, signal, (text) => stdout.write(text + "\n")) },
        maxSteps: config.maxSteps, signal: active.signal,
        emit: (text, thinking) => {
          if (thinking !== channel) { stdout.write(`\n${thinking ? "[thinking] " : "[answer] "}`); channel = thinking; }
          stdout.write(thinking && stdout.isTTY ? `\x1b[2m${clean(text)}\x1b[0m` : clean(text));
        },
        log: (text) => { channel = undefined; stdout.write(`\n${clean(text.slice(0, 1200))}${text.length > 1200 ? " …" : ""}\n`); },
        save: (batch) => history.append(batch)
      });
      if (command === "run" && status === "limit") { process.exitCode = 2; }
    } catch (error) {
      stdout.write(`\n${clean(errorText(error))}\n`);
      if (command === "run") { process.exitCode = 1; }
    } finally { active = undefined; stdout.write("\n"); }
  };
  try {
    if (command === "run") { await execute(args[1]!); return; }
    if (!stdin.isTTY) { throw new Error("Chat requires a terminal; use stick run <task>"); }
    stdout.write(renderModelPicker(ram, Boolean(stdout.isTTY)) + "\n");
    while (true) {
      try {
        const input = await terminal.question(`Model [${config.model === "stellan-1-lite" ? "1" : "2"}]: `);
        if (input.trim() === "/exit") { return; }
        const selected = pickModel(input, config.model, ram);
        config.model = selected; model = modelClient(selected); break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") { return; }
        stdout.write(clean(errorText(error)) + "\n");
      }
    }
    stdout.write(`stick_ai · ${clean(config.model)} · /exit /clear /history\n`);
    while (true) {
      let input: string;
      try { input = (await terminal.question("stick> ")).trim(); } catch { break; }
      if (input === "/exit") { break; }
      if (input === "/clear") { await history.clear(); messages.length = 0; continue; }
      if (input === "/history") { stdout.write(clean(JSON.stringify(messages, null, 2)) + "\n"); continue; }
      if (input) { await execute(input); }
    }
  } finally { terminal.close(); process.removeListener("SIGINT", interrupt); }
}
main().catch((error) => { console.error(clean(errorText(error))); process.exitCode = 1; }).finally(async () => { try { if (managed) { await managed.close(); } } finally { if (release) { await release(); } } }).catch((error) => { console.error(clean(errorText(error))); process.exitCode = 1; });
