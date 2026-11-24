import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caretEscape, planCommand, quoteWindowsArgument, resolveWindowsCommand, spawnCommand, windowsBatchCommandLine } from "../src/portable/spawn-command.js";

it("quotes arguments exactly as Windows programs read them back", () => {
  expect(quoteWindowsArgument("")).toBe('""');
  expect(quoteWindowsArgument("plain")).toBe('"plain"');
  expect(quoteWindowsArgument("two words")).toBe('"two words"');
  expect(quoteWindowsArgument('say "hi"')).toBe('"say \\"hi\\""');
  expect(quoteWindowsArgument("C:\\path\\")).toBe('"C:\\path\\\\"');
  expect(quoteWindowsArgument('a\\"b')).toBe('"a\\\\\\"b"');
  expect(quoteWindowsArgument("a\\b")).toBe('"a\\b"');
  expect(caretEscape('x & del "y" | %PATH%')).toBe('x^ ^&^ del^ ^"y^"^ ^|^ ^%PATH^%');
});

it("runs Windows batch commands through cmd.exe with every argument escaped, and never searches the project folder", () => {
  const env = { Path: "C:\\Program Files\\nodejs;C:\\Tools", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  const files = new Set(["C:\\Program Files\\nodejs\\npx.cmd", "C:\\Tools\\server.exe", "C:\\project\\evil.cmd"]);
  const exists = (path: string) => files.has(path);
  expect(resolveWindowsCommand("npx", env, exists)).toBe("C:\\Program Files\\nodejs\\npx.cmd");
  expect(resolveWindowsCommand("evil", env, exists)).toBeUndefined();
  expect(resolveWindowsCommand(".\\evil.cmd", env, exists)).toBeUndefined();
  expect(planCommand("server", ["--port", "1"], env, "win32", exists)).toEqual({ file: "C:\\Tools\\server.exe", args: ["--port", "1"], verbatim: false });
  const plan = planCommand("npx", ["-y", "@scope/server", "a & calc"], env, "win32", exists);
  expect(plan.file).toBe("C:\\Windows\\system32\\cmd.exe"); expect(plan.verbatim).toBe(true);
  expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  expect(plan.args[3]).toBe('"C:\\Program^ Files\\nodejs\\npx.cmd ^^^"-y^^^" ^^^"@scope/server^^^" ^^^"a^^^ ^^^&^^^ calc^^^""');
  expect(windowsBatchCommandLine("C:\\p\\tool.cmd", ['say "x"', "& calc"])).toBe('C:\\p\\tool.cmd ^^^"say^^^ \\^^^"x\\^^^"^^^" ^^^"^^^&^^^ calc^^^"');
  expect(planCommand("npx", ["-y"], { PATH: "/usr/bin" }, "linux")).toEqual({ file: "npx", args: ["-y"], verbatim: false });
});

it.runIf(process.platform === "win32")("passes awkward arguments through a real .cmd file unchanged on Windows", async () => {
  const folder = await mkdtemp(join(tmpdir(), "stick-spawn-"));
  try {
    await writeFile(join(folder, "echo-args.cmd"), '@node -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n');
    const args = ["plain", "two words", 'quote " inside', "a & echo INJECTED", "pipe | more", "%PATH%", "caret ^ here", "trailing\\", "(paren)", "!bang!", ""];
    const child = spawnCommand("echo-args", args, { env: { ...process.env, PATH: `${folder};${process.env.PATH ?? ""}` }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout?.on("data", (chunk) => { output += chunk; });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual(args);
  } finally { await rm(folder, { recursive: true, force: true }); }
}, 30000);

it("starts ordinary programs directly on every system", async () => {
  const child = spawnCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "x y", 'z"'], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout?.on("data", (chunk) => { output += chunk; });
  expect(await new Promise((resolve) => child.on("close", resolve))).toBe(0);
  expect(JSON.parse(output)).toEqual(["x y", 'z"']);
});
