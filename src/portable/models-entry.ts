import { appFetch } from "./net.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { lockedModels } from "./locked-models.js";
import { lockedNames, lockModel, unlockModel } from "./model-lock.js";
const lockKeysUrl = "https://stick-ai.localilabs.com/api/activation-admin";
import { linkModelFile, localModelStatus, LocalModelError, modelKind, unlinkModelFile } from "./local-models.js";
const args = process.argv.slice(2);
function argument(name: string): string { const at = args.indexOf(name); const value = args[at + 1]; if (at < 0 || !value) { throw new Error("Missing model argument"); } return value; }
// The owner's "Lock models" step (run by the install helpers): locks the plain models in stellan/models with the
// keys from the website, checks the result against the pinned layout, then removes the plain files.
async function lockStick(root: string): Promise<void> {
  const password = (process.env.STICK_LOCK_PASSWORD ?? await new Promise<string>((resolve) => { let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { text += chunk; }); process.stdin.on("end", () => resolve(text)); })).trim();
  if (!password) { throw new LocalModelError("Enter the activation desk password."); }
  let reply: Response;
  try { reply = await appFetch(lockKeysUrl, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: password, action: "modelkeys" }), signal: AbortSignal.timeout(30000) }); }
  catch { throw new LocalModelError("Locking needs the internet to fetch the keys. Connect and try again."); }
  const body = await reply.json().catch(() => ({})) as { keys?: Record<string, string>; error?: string };
  if (!reply.ok || !body.keys) { throw new LocalModelError(reply.status === 403 ? "That password isn't right." : body.error ?? "The website didn't hand out the keys. Try again in a minute."); }
  const done: string[] = [];
  for (const [model, locked] of Object.entries(lockedModels)) {
    const plain = join(root, `${locked.base}.gguf`); const key = Buffer.from(body.keys[model] ?? "", "base64");
    if (!await stat(plain).then(() => true, () => false)) { continue; }
    if (key.length !== 32) { throw new LocalModelError("The website's keys look wrong. Set up activation again on the activation desk."); }
    console.error(`Locking ${basename(plain)} (a few minutes)...`);
    const result = await lockModel(plain, join(root, locked.base), key, locked.label);
    const check = await mkdtemp(join(tmpdir(), "stick-lock-"));
    try {
      const names = lockedNames(basename(locked.base)); const first = await unlockModel(result.locked, check, names.first, key, locked.label);
      const sha = createHash("sha256").update(await readFile(first)).digest("hex");
      if (result.firstSha256 !== locked.firstSha256 || sha !== locked.firstSha256 || result.restSha256 !== locked.restSha256 || result.restSize !== locked.restSize) {
        await rm(result.locked, { force: true }); await rm(result.rest, { force: true });
        throw new LocalModelError(`${basename(plain)} isn't the official file, so it was left as it is.`);
      }
    } finally { await rm(check, { recursive: true, force: true }); }
    await rm(plain); done.push(model);
  }
  console.log(JSON.stringify({ locked: done }));
}
async function main(): Promise<void> {
  const root = argument("--root");
  if (args.includes("--lock")) { await lockStick(root); return; }
  const kind = modelKind(args.includes("--model") ? argument("--model") : "max");
  if (args.includes("--link")) { await linkModelFile(root, kind, argument("--link")); }
  if (args.includes("--unlink")) { await unlinkModelFile(root, kind); }
  console.log(JSON.stringify(await localModelStatus(root)));
}
if (process.argv[1] && /(?:stick-models\.cjs|models-entry\.js)$/.test(process.argv[1])) {
  main().catch((error: unknown) => { console.log(JSON.stringify({ error: error instanceof LocalModelError ? error.message : args.includes("--lock") ? `Locking stopped: ${error instanceof Error ? error.message : String(error)}` : "The model could not be linked. Check the file and try again." })); process.exitCode = 1; });
}
