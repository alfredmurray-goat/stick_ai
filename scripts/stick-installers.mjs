// Helpers shipped next to the stick files in the release zip. They copy the apps and the stellan folder onto
// a USB stick by merging: files are added or replaced, nothing is deleted, so stellan/models stays as it is.
// (Dragging a folder onto a stick in Finder offers "Replace", which would delete the models.)
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

const lite = "stellan-1-lite-q4_k_m.gguf", max = "stellan-1.0-q4_k_m.gguf";
const posixCheck = `
missing=""
[ -f "$DEST/stellan/models/${lite}" ] || missing="$missing ${lite}"
[ -f "$DEST/stellan/models/${max}" ] || missing="$missing ${max}"
if [ -n "$missing" ]; then
  printf '%s\\n' "" "Stick AI is on the stick. Now copy these model files into stellan/models on the stick:" "  $missing" "Use exactly these names. Lite is needed; Max is optional."
else
  printf '%s\\n' "" "Done. Stick AI and both models are on the stick. Eject it before unplugging."
fi
`;
export const macInstaller = `#!/bin/sh
cd -P "$(dirname "$0")" || exit 1
SRC="$PWD/stick_ai"
[ -d "$SRC" ] || { echo "Keep this file next to the stick_ai folder from the download."; exit 1; }
printf '%s\\n' "Stick AI: put the app on a USB stick" "" "Drag the USB stick from the Finder sidebar into this window, then press Return:"
read -r DEST
DEST=$(printf '%s' "$DEST" | sed -e "s/^[[:space:]]*'//" -e "s/'[[:space:]]*$//" -e 's/\\\\ / /g' -e 's/[[:space:]]*$//')
[ -d "$DEST" ] || { echo "That isn't a folder or stick. Close this window and try again."; exit 1; }
# Merge into the stick without copying download-quarantine flags or extended attributes (which exFAT can't hold).
ditto --noextattr --noqtn "$SRC" "$DEST" || { echo "Copying failed. Check the stick has space and isn't locked."; exit 1; }
${posixCheck}`;
export const linuxInstaller = `#!/bin/sh
cd -P "$(dirname "$0")" || exit 1
SRC="$PWD/stick_ai"
[ -d "$SRC" ] || { echo "Keep this file next to the stick_ai folder from the download."; exit 1; }
DEST="$1"
if [ -z "$DEST" ]; then printf '%s' "Type the path of the USB stick (for example /media/$USER/STICK_AI) and press Enter: "; read -r DEST; fi
[ -d "$DEST" ] || { echo "That folder wasn't found."; exit 1; }
cp -R "$SRC"/. "$DEST"/ || { echo "Copying failed. Check the stick has space and isn't locked."; exit 1; }
${posixCheck}`;
export const windowsInstaller = [
  "@echo off",
  "setlocal",
  'set "SRC=%~dp0stick_ai"',
  'if not exist "%SRC%\\stellan" (echo Keep this file next to the stick_ai folder from the download. & pause & exit /b 1)',
  "echo Stick AI: put the app on a USB stick",
  "echo.",
  'set /p "DRIVE=Type the letter of your USB stick (for example E) and press Enter: "',
  'set "DRIVE=%DRIVE::=%"',
  'set "DRIVE=%DRIVE:\\=%"',
  'if not exist "%DRIVE%:\\" (echo That drive wasn\'t found. & pause & exit /b 1)',
  'robocopy "%SRC%" "%DRIVE%:\\" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP',
  "if errorlevel 8 (echo Copying failed. Check the stick has space and isn't locked. & pause & exit /b 1)",
  `set "MISSING="`,
  `if not exist "%DRIVE%:\\stellan\\models\\${lite}" set "MISSING=%MISSING% ${lite}"`,
  `if not exist "%DRIVE%:\\stellan\\models\\${max}" set "MISSING=%MISSING% ${max}"`,
  "echo.",
  'if defined MISSING (echo Stick AI is on the stick. Now copy these model files into stellan\\models on the stick:%MISSING% & echo Use exactly these names. Lite is needed; Max is optional.) else (echo Done. Stick AI and both models are on the stick. Eject it before unplugging.)',
  "pause",
  ""
].join("\r\n");
export const installNotes = `HOW TO PUT STICK AI ON A STICK

1. Use a USB stick formatted as exFAT (32 GB or more) with your models in
   stellan/models:  ${lite}  and  ${max}
2. Open the helper for this computer and follow it:
     Mac      Install on stick (Mac).command   (right-click > Open the first time)
     Windows  Install on stick (Windows).bat
     Linux    sh install-on-stick.sh /path/to/stick
3. It copies the apps and the stellan folder onto the stick. It never deletes
   anything, so your models stay where they are.

Don't drag the stellan folder onto the stick in Finder: "Replace" would delete the models.
`;
export async function writeInstallers(folder) {
  await writeFile(join(folder, "Install on stick (Mac).command"), macInstaller, { mode: 0o755 });
  await writeFile(join(folder, "install-on-stick.sh"), linuxInstaller, { mode: 0o755 });
  await writeFile(join(folder, "Install on stick (Windows).bat"), windowsInstaller);
  await writeFile(join(folder, "How to install.txt"), installNotes);
  for (const name of ["Install on stick (Mac).command", "install-on-stick.sh"]) { await chmod(join(folder, name), 0o755); }
}
