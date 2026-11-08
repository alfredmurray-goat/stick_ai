import { dryRunActions } from "../dist/portable/entry.js";
for (const action of dryRunActions("<USB stick>")) { console.log(action); }
