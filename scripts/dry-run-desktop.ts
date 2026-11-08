import { desktopDryRun } from "../dist/portable/desktop.js";
for (const action of desktopDryRun(process.cwd())) { console.log(action); }
