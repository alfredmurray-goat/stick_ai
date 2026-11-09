import { linkMaxFile, localModelStatus, LocalModelError, unlinkMaxFile } from "./local-models.js";
const args = process.argv.slice(2);
function argument(name: string): string { const at = args.indexOf(name); const value = args[at + 1]; if (at < 0 || !value) { throw new Error("Missing model argument"); } return value; }
async function main(): Promise<void> {
  const root = argument("--root");
  if (args.includes("--link")) { await linkMaxFile(root, argument("--link")); }
  if (args.includes("--unlink")) { await unlinkMaxFile(root); }
  console.log(JSON.stringify(await localModelStatus(root)));
}
if (process.argv[1] && /(?:stick-models\.cjs|models-entry\.js)$/.test(process.argv[1])) {
  main().catch((error: unknown) => { console.log(JSON.stringify({ error: error instanceof LocalModelError ? error.message : "The Max model could not be linked. Check the file and try again." })); process.exitCode = 1; });
}
