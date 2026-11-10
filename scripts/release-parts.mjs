import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export async function splitArchive(input, output, limit = 2000 * 1024 ** 2, onPart) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit >= 2 * 1024 ** 3) { throw new Error("Invalid release part size"); }
  const name = basename(input);
  if (!/^stick_ai-[a-z0-9-]+\.(zip|tar\.gz|dmg)$/.test(name)) { throw new Error("Unsafe archive name"); }
  await mkdir(output, { recursive: true });
  const whole = createHash("sha256"); const parts = []; let size = 0; let handle; let partHash; let partSize = 0; let partName;
  async function finish() {
    if (!handle) { return; }
    await handle.sync(); await handle.close(); handle = undefined;
    const record = { name: partName, size: partSize, sha256: partHash.digest("hex") }; parts.push(record);
    if (onPart) { await onPart(record, join(output, partName)); }
  }
  try {
    for await (const chunk of createReadStream(input)) {
      whole.update(chunk); size += chunk.length; let offset = 0;
      while (offset < chunk.length) {
        if (!handle) {
          partName = `${name}.part${String(parts.length + 1).padStart(2, "0")}`;
          handle = await open(join(output, partName), "wx"); partHash = createHash("sha256"); partSize = 0;
        }
        const slice = chunk.subarray(offset, offset + Math.min(limit - partSize, chunk.length - offset));
        let written = 0;
        while (written < slice.length) { const result = await handle.write(slice.subarray(written)); if (!result.bytesWritten) { throw new Error("Unable to write release part"); } written += result.bytesWritten; }
        partHash.update(slice); offset += slice.length; partSize += slice.length;
        if (partSize === limit) { await finish(); }
      }
    }
    await finish();
  } finally { await handle?.close(); }
  if (!parts.length) { throw new Error("Empty release archive"); }
  return { name, size, sha256: whole.digest("hex"), parts };
}
export async function joinHelper(record, output, platform) {
  const check = (file, hash) => `check '${file}' '${hash}' || fail`;
  const base = record.name.replace(/\.(zip|tar\.gz|dmg)$/, "");
  if (platform !== "windows-x64") {
    const name = `Join-${base}.${platform.startsWith("macos-") ? "command" : "sh"}`;
    const text = `#!/bin/sh
cd -P "$(dirname "$0")" || exit 1
fail() { printf '%s\\n' 'These downloads may be incomplete; download all parts again.'; exit 1; }
check() { if command -v shasum >/dev/null 2>&1; then HASH=$(shasum -a 256 "$1") || return 1; else HASH=$(sha256sum "$1") || return 1; fi; [ "\${HASH%% *}" = "$2" ]; }
${record.parts.map((part) => check(part.name, part.sha256)).join("\n")}
[ ! -e '${record.name}' ] && [ ! -e '${record.name}.joining' ] || { printf '%s\\n' 'The finished download already exists; open it to continue.'; exit 1; }
trap 'rm -f "${record.name}.joining"' EXIT HUP INT TERM
cat ${record.parts.map((part) => `'${part.name}'`).join(" ")} > '${record.name}.joining' || fail
${check(record.name + ".joining", record.sha256)}
mv '${record.name}.joining' '${record.name}' || fail
printf '%s\\n' 'Your download is ready; open the finished archive and keep its folder together.'
`;
    await writeFile(join(output, name), text, { mode: 0o755 }); return name;
  }
  const name = `Join-${base}.bat`;
  const checks = record.parts.map((part) => `if ((Get-FileHash -LiteralPath '${part.name}' -Algorithm SHA256).Hash -ne '${part.sha256}') { throw 'changed part' };`).join(" ");
  const streams = record.parts.map((part) => `$i=[IO.File]::OpenRead('${part.name}'); try { $i.CopyTo($o) } finally { $i.Dispose() };`).join(" ");
  const command = `$ErrorActionPreference='Stop'; $created=$false; try { ${checks} $o=[IO.File]::Open('${record.name}.joining',[IO.FileMode]::CreateNew); $created=$true; try { ${streams} } finally { $o.Dispose() }; if ((Get-FileHash -LiteralPath '${record.name}.joining' -Algorithm SHA256).Hash -ne '${record.sha256}') { throw 'changed archive' }; [IO.File]::Move('${record.name}.joining','${record.name}'); Write-Host 'Your download is ready; open the finished archive and keep its folder together.' } catch { if ($created) { Remove-Item -LiteralPath '${record.name}.joining' -Force -ErrorAction SilentlyContinue }; Write-Host 'These downloads may be incomplete; download all parts again.'; exit 1 }`;
  await writeFile(join(output, name), `@echo off\r\nsetlocal DisableDelayedExpansion\r\ncd /d "%~dp0"\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -Command "${command}"\r\nset "RESULT=%ERRORLEVEL%"\r\npause >nul\r\nexit /b %RESULT%\r\n`); return name;
}
