// Helpers shipped next to the stick files in the release zip. They copy the apps and the stellan folder onto
// a USB stick by merging: files are added or replaced, nothing is deleted, so stellan/models stays as it is.
// (Dragging a folder onto a stick in Finder offers "Replace", which would delete the models.)
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

const lite = "stellan-1-lite-q4_k_m.gguf", max = "stellan-1.0-q4_k_m.gguf";
const liteBase = "stellan-1-lite-q4_k_m", maxBase = "stellan-1.0-q4_k_m";
// A model counts as there if it's plain or locked (an encrypted .locked part plus the rest; see model-lock.ts).
// If plain models are there, the owner can lock them for selling: it needs the activation desk password.
const posixCheck = `
M="$DEST/stellan/models"
has() { [ -f "$M/$1.gguf" ] || { [ -f "$M/$1.locked" ] && [ -f "$M/$1-00002-of-00002.gguf" ]; }; }
missing=""
has ${liteBase} || missing="$missing ${lite}"
has ${maxBase} || missing="$missing ${max}"
if [ -n "$missing" ]; then
  printf '%s\\n' "" "Stick AI is on the stick. Now copy these model files into stellan/models on the stick:" "  $missing" "Use exactly these names. Lite is needed; Max is optional. Then open this helper again."
  exit 0
fi
if [ -f "$M/${lite}" ] || [ -f "$M/${max}" ]; then
  printf '%s\\n' "" "The models are plain files. For a stick you sell, lock them so they only work after activation." "Lock them now? It needs the internet and the activation desk password, and takes a few minutes." "Type y and press Return, or just press Return to skip:"
  read -r LOCK || LOCK=""
  case "$LOCK" in y|Y|yes|YES)
    case "$(uname -s)-$(uname -m)" in Darwin-arm64) T=macos-arm64;; Darwin-*) T=macos-x64;; *) T=linux-x64;; esac
    printf '%s' "Activation desk password (it won't show as you type): "; stty -echo 2>/dev/null; read -r STICK_LOCK_PASSWORD; stty echo 2>/dev/null; echo ""
    export STICK_LOCK_PASSWORD
    "$DEST/stellan/bin/$T/node" "$DEST/stellan/app/stick-models.cjs" --root "$DEST/stellan" --lock < /dev/null || { unset STICK_LOCK_PASSWORD; echo "The models weren't locked; they're unchanged. Check the message above and try again."; exit 1; }
    unset STICK_LOCK_PASSWORD
    printf '%s\\n' "" "Locked. Copy stellan/models from this stick to your other sticks: they're the same for every stick."
    ;;
  esac
fi
printf '%s\\n' "" "Done. Stick AI and both models are on the stick. Eject it before unplugging."
`;
export const macInstaller = `#!/bin/sh
cd -P "$(dirname "$0")" || exit 1
SRC="$PWD/stick_ai"
[ -d "$SRC" ] || { echo "Keep this file next to the stick_ai folder from the download."; exit 1; }
# STICK_VOLUMES only exists so tests can stand in for /Volumes. Resolve it like $PWD (cd -P), so
# folders reached through a symlink (macOS /var -> /private/var) still match.
VOLUMES=$(cd -P "\${STICK_VOLUMES:-/Volumes}" 2>/dev/null && pwd || echo /Volumes)
# Unzipped straight onto the stick? Then that stick is the obvious target.
HERE=""
case "$PWD/" in "$VOLUMES"/*/*) HERE="$VOLUMES/$(printf '%s' "\${PWD#"$VOLUMES"/}" | cut -d/ -f1)";; esac
printf '%s\\n' "Stick AI: put the app on a USB stick" ""
for attempt in 1 2 3; do
  if [ -n "$HERE" ]; then
    printf '%s\\n' "Press Return to install on $(basename "$HERE"), or drag a different stick from the Finder sidebar into this window and press Return:"
  else
    printf '%s\\n' "Drag the USB stick from the Finder sidebar into this window, then press Return:"
  fi
  read -r DEST || DEST=""
  DEST=$(printf '%s' "$DEST" | sed -e "s/^[[:space:]]*'//" -e "s/'[[:space:]]*$//" -e 's/\\\\ / /g' -e 's/[[:space:]]*$//')
  [ -z "$DEST" ] && DEST="$HERE"
  [ -n "$DEST" ] && [ -d "$DEST" ] && break
  echo "That isn't a folder or stick. Try again (for example /Volumes/STICK_AI)."; echo ""; DEST=""
done
[ -n "$DEST" ] || { echo "No stick chosen. Close this window and open the helper again."; exit 1; }
echo "Copying Stick AI onto $DEST ..."
# Merge into the stick without copying download-quarantine flags or extended attributes (which exFAT can't hold).
ditto --noextattr --noqtn "$SRC" "$DEST" || { echo "Copying failed. Check the stick has space and isn't locked."; exit 1; }
case "$PWD/" in "$DEST"/*) printf '%s\\n' "" "You can now delete the download folder on the stick ($(basename "$PWD")) to free space.";; esac
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
  // Run from the stick itself (unzipped onto it)? Pressing Enter uses that drive.
  'set "HERE=%~d0"',
  'set "HERE=%HERE::=%"',
  'set "DRIVE="',
  'if /i "%HERE%"=="C" (set /p "DRIVE=Type the letter of your USB stick (for example E) and press Enter: ") else (set /p "DRIVE=Press Enter to install on drive %HERE%:, or type another drive letter: ")',
  // Never fall back to the system drive.
  'if not defined DRIVE if /i not "%HERE%"=="C" set "DRIVE=%HERE%"',
  'if not defined DRIVE (echo No stick chosen. Open this helper again and type the stick\'s letter. & pause & exit /b 1)',
  'set "DRIVE=%DRIVE::=%"',
  'set "DRIVE=%DRIVE:\\=%"',
  'if /i "%DRIVE%"=="C" (echo C is your computer\'s main drive, not a stick. Open this helper again and type the stick\'s letter. & pause & exit /b 1)',
  'if not exist %DRIVE%:\\ (echo That drive wasn\'t found. & pause & exit /b 1)',
  // Not "D:\\": a backslash before a closing quote escapes the quote and garbles every argument after it.
  'robocopy "%SRC%" %DRIVE%:\\ /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP',
  "if errorlevel 8 (echo Copying failed. Check the stick has space and isn't locked. & pause & exit /b 1)",
  `set "M=%DRIVE%:\\stellan\\models"`,
  `set "MISSING="`,
  `if not exist "%M%\\${lite}" if not exist "%M%\\${liteBase}.locked" set "MISSING=%MISSING% ${lite}"`,
  `if not exist "%M%\\${max}" if not exist "%M%\\${maxBase}.locked" set "MISSING=%MISSING% ${max}"`,
  "echo.",
  'if defined MISSING (echo Stick AI is on the stick. Now copy these model files into stellan\\models on the stick:%MISSING% & echo Use exactly these names. Lite is needed; Max is optional. Then open this helper again. & pause & exit /b 0)',
  `set "PLAIN="`,
  `if exist "%M%\\${lite}" set "PLAIN=1"`,
  `if exist "%M%\\${max}" set "PLAIN=1"`,
  "if not defined PLAIN goto finished",
  "echo The models are plain files. For a stick you sell, lock them so they only work after activation.",
  'set "LOCK="',
  'set /p "LOCK=Lock them now? It needs the internet and the activation desk password. Type y and press Enter, or just press Enter to skip: "',
  'if /i not "%LOCK%"=="y" goto finished',
  'set /p "STICK_LOCK_PASSWORD=Activation desk password: "',
  "cls",
  '"%DRIVE%:\\stellan\\bin\\windows-x64\\node.exe" "%DRIVE%:\\stellan\\app\\stick-models.cjs" --root "%DRIVE%:\\stellan" --lock < nul',
  'if errorlevel 1 (set "STICK_LOCK_PASSWORD=" & echo The models weren\'t locked; they\'re unchanged. Check the message above and try again. & pause & exit /b 1)',
  'set "STICK_LOCK_PASSWORD="',
  "echo Locked. Copy stellan\\models from this stick to your other sticks: they're the same for every stick.",
  ":finished",
  "echo.",
  "echo Done. Stick AI and both models are on the stick. Eject it before unplugging.",
  "pause",
  ""
].join("\r\n");
export const installNotes = `HOW TO PUT STICK AI ON A STICK

1. Use a USB stick formatted as exFAT (32 GB or more) with your models in
   stellan/models:  ${lite}  and  ${max}
2. Open the helper for this computer and follow it:
     Mac      Install on stick (Mac).command   (first time: System Settings > Privacy & Security > Open Anyway)
     Windows  Install on stick (Windows).bat
     Linux    sh install-on-stick.sh /path/to/stick
   If you unzipped this download onto the stick itself, just press Return
   (Enter on Windows) when the helper asks which stick.
3. It copies the apps and the stellan folder onto the stick. It never deletes
   anything, so your models stay where they are. Afterwards you can delete the
   download folder from the stick.

Don't drag the stellan folder onto the stick in Finder: "Replace" would delete the models.
`;
export async function writeInstallers(folder) {
  await writeFile(join(folder, "Install on stick (Mac).command"), macInstaller, { mode: 0o755 });
  await writeFile(join(folder, "install-on-stick.sh"), linuxInstaller, { mode: 0o755 });
  await writeFile(join(folder, "Install on stick (Windows).bat"), windowsInstaller);
  await writeFile(join(folder, "How to install.txt"), installNotes);
  for (const name of ["Install on stick (Mac).command", "install-on-stick.sh"]) { await chmod(join(folder, name), 0o755); }
}
