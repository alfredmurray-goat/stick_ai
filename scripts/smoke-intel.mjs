import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ManagedEngine } from "../dist/portable/engine.js";
import { reservePort } from "../dist/portable/ports.js";
import { Ollama } from "../dist/model/ollama.js";
import { ramStatus } from "../dist/config/models.js";
import { parseStep } from "../dist/model/protocol.js";
const root = resolve(process.argv[2]); const temporary = await mkdtemp(join(tmpdir(), "stick-smoke-"));
await mkdir("release-assets", { recursive: true });
const fd = openSync("release-assets/smoke.log", "a", 0o600); const reservation = await reservePort(); await reservation.release();
const engine = new ManagedEngine(root, "macos-x64", reservation.port, temporary, fd, console.error); engine.patient = true;
const signal = AbortSignal.timeout(10 * 60 * 1000);
try {
  await engine.start("stellan-1-lite", signal);
  const client = new Ollama("stellan-1-lite", engine.baseUrl, false, ramStatus(), { apiKey: engine.key, maxTokens: 256 });
  const result = await client.complete([{ role: "system", content: 'You are Stellan-1 Lite. This is a startup check. Reply with exactly <done>Ready</done>. Do not call tools or write code.' }, { role: "user", content: "Are you ready?" }], signal, () => {});
  const parsed = parseStep(result.content);
  await writeFile("release-assets/model-smoke.json", JSON.stringify({ architecture: "mamba2", response: result.content, protocol: parsed.step.kind }, null, 2));
  if (parsed.step.kind !== "done") { throw new Error("Lite loaded, but did not follow its required tagged protocol; inspect model-smoke.json before shipping"); }
  console.log("Intel Lite model loaded, streamed a tagged answer, and passed authenticated readiness checks.");
} finally { engine.disposing = true; await engine.stop(); closeSync(fd); await rm(temporary, { recursive: true, force: true }); }
