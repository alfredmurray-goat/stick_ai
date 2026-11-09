const token = location.hash.slice(1);
const native = !token && window.__TAURI__?.core;
if (token) { history.replaceState(null, "", "/"); }
const byId = (id) => document.getElementById(id);
let after = 0;
let streaming;
let streamKind;
let working = false;
let lastTask = "";
let retryStart = true;
let nativeStarted = 0;
let errorAction = "Retry";
let polling = false;
let nativeStarting = false;
let installingUpdate = false;
async function api(path, data) {
  const response = await fetch(path, { method: data ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}), cache: "no-store" });
  if (!response.ok) { throw new Error("unavailable"); }
  return response.json();
}
function showError(problem = {}) {
  byId("error-message").textContent = problem.message || "The assistant could not finish this step. Try again.";
  byId("error-explanation").textContent = problem.explanation || "";
  errorAction = problem.action || "Retry";
  byId("error-action").textContent = errorAction;
  byId("error").hidden = false;
}
function progress(view, busy) {
  working = busy; byId("progress").hidden = !busy;
  byId("status").textContent = view?.message || "Thinking...";
  byId("elapsed").textContent = view?.elapsedSeconds == null ? "" : ` ${view.elapsedSeconds} seconds`;
  byId("reassurance").textContent = view?.reassurance || "";
}
function message(text, kind = "answer") {
  if (kind === "thinking" || kind === "coding") {
    byId(kind === "thinking" ? "thoughts" : "code-preview").hidden = false;
    byId(kind).textContent += text; return;
  }
  if (!streaming || streamKind !== kind) { streaming = document.createElement("pre"); streaming.className = kind; byId("messages").append(streaming); streamKind = kind; }
  streaming.textContent += text;
}
async function start(faster = false) {
  if (installingUpdate) { return; }
  byId("app-updates").hidden = true;
  retryStart = true; byId("error").hidden = true; byId("start").disabled = true;
  if (native) {
    nativeStarting = true; nativeStarted = Date.now(); byId("welcome").hidden = true;
    progress({ message: "Starting your private assistant..." }, true);
    try {
      const url = await native.invoke("start_assistant", { faster });
      location.replace(url);
    } catch { const state = await native.invoke("desktop_status").catch(() => ({})); showError(state.error); progress(null, false); }
    finally { nativeStarting = false; byId("start").disabled = false; }
  } else {
    try { await api(faster ? "/api/faster" : "/api/start", faster ? {} : { model: "stellan-1-lite" }); }
    catch { showError(); byId("start").disabled = false; }
  }
}
async function task(text) {
  if (!text.trim()) { return; }
  retryStart = false; lastTask = text; byId("error").hidden = true;
  streaming = undefined; message(text, "you"); streaming = undefined;
  for (const id of ["thinking", "coding"]) { byId(id).textContent = ""; }
  byId("thoughts").open = false; byId("thoughts").hidden = true; byId("code-preview").hidden = true;
  byId("prompt").value = "";
  try { await api("/api/task", { text }); } catch { showError(); }
}
byId("start").onclick = () => start();
byId("question").onsubmit = (event) => { event.preventDefault(); void task(byId("prompt").value); };
byId("thoughts").ontoggle = () => { byId("thoughts").querySelector("summary").textContent = byId("thoughts").open ? "Hide thinking" : "Show thinking"; };
byId("cancel").onclick = () => { void (native ? native.invoke("cancel_start") : api("/api/cancel", {})).catch(() => {}); };
document.addEventListener("keydown", (event) => { if (working && event.ctrlKey && event.key.toLowerCase() === "c") { event.preventDefault(); byId("cancel").click(); } });
byId("error-action").onclick = async () => {
  byId("error").hidden = true;
  if (errorAction === "OK") { if (!native) { await api("/api/dismiss", {}).catch(() => {}); } else { byId("welcome").hidden = false; } return; }
  if (errorAction === "Switch to a faster setting") { await start(true); return; }
  if (retryStart) { await start(); } else { await task(lastTask); }
};
byId("stop").onclick = () => api("/api/stop", {}).catch(() => {});
async function update() {
  if (polling) { return; } polling = true;
  try {
    if (native) {
      if (!nativeStarting) { return; }
      const state = await native.invoke("desktop_status");
      const seconds = Math.floor((Date.now() - nativeStarted) / 1000);
      progress({ message: state.message || "Starting your private assistant...", elapsedSeconds: seconds >= 10 ? seconds : null, reassurance: seconds >= 60 ? "Still working. Large models on this computer can take a few minutes." : null }, state.running);
      if (state.error) { showError(state.error); }
      return;
    }
    const state = await api(`/api/state?after=${after}`);
    byId("welcome").hidden = !(["choose", "error"].includes(state.phase) && !state.problem);
    byId("loading").hidden = state.phase !== "starting";
    byId("chat").hidden = !["ready", "working"].includes(state.phase);
    byId("footer").hidden = byId("chat").hidden;
    byId("stop").hidden = state.desktop;
    byId("send").disabled = state.phase !== "ready";
    byId("start").disabled = false;
    progress(state.progress, ["starting", "working"].includes(state.phase));
    if (state.problem) { showError(state.problem); }
    for (const event of state.events) {
      after = event.id;
      if (["answer", "thinking", "coding"].includes(event.kind)) { message(event.text, event.kind); }
      if (event.kind === "status") { byId("status").textContent = event.text; }
      if (event.kind === "problem") { showError(event.data); }
      if (event.kind === "approval") {
        const card = document.createElement("article"); const title = document.createElement("h3"); title.textContent = `Save changes to ${event.data.file}?`;
        const preview = document.createElement("pre"); preview.textContent = event.data.after; card.append(title, preview);
        for (const [label, allow] of [["Allow changes", true], ["Keep my file", false]]) {
          const button = document.createElement("button"); button.textContent = label;
          button.onclick = async () => { try { await api("/api/approve", { id: event.data.id, allow }); card.remove(); } catch { showError(); } }; card.append(button);
        }
        byId("approvals").append(card);
      }
    }
  } catch { if (!native) { showError({ message: "The assistant has stopped. Open the app again to continue.", action: "OK" }); } }
  finally { polling = false; }
}
setInterval(update, 500);
if (!native) { void update(); }

async function checkAppUpdates() {
  if (!native || installingUpdate) { return; }
  byId("check-update").disabled = true;
  byId("update-message").textContent = "Checking for app updates...";
  byId("install-update").hidden = true;
  try {
    const result = await native.invoke("check_app_updates");
    const size = result.bytes ? ` Download: ${(result.bytes / 1024 / 1024).toFixed(1)} MB.` : "";
    byId("update-message").textContent = result.message + size;
    byId("install-update").hidden = result.state !== "available";
    if (result.state === "authentication") { byId("update-access").open = true; }
  } catch { byId("update-message").textContent = "Updates are unavailable. You can keep using the app offline."; }
  finally { byId("check-update").disabled = false; }
}
async function saveUpdateAccess(clearToken = false) {
  const tokenInput = byId("update-token");
  try {
    const settings = await native.invoke("save_app_update_settings", { enabled: byId("auto-updates").checked, token: tokenInput.value || null, clearToken });
    tokenInput.value = "";
    byId("update-message").textContent = settings.hasToken ? "GitHub access saved on this computer." : "Update preferences saved.";
    if (!clearToken && byId("auto-updates").checked) { await checkAppUpdates(); }
  } catch { tokenInput.value = ""; byId("update-message").textContent = "Update preferences could not be saved."; }
}
if (native) {
  byId("app-updates").hidden = false;
  byId("check-update").onclick = () => checkAppUpdates();
  byId("auto-updates").onchange = () => saveUpdateAccess();
  byId("save-update-access").onclick = () => saveUpdateAccess();
  byId("clear-update-access").onclick = () => saveUpdateAccess(true);
  byId("install-update").onclick = async () => {
    installingUpdate = true; byId("start").disabled = true; byId("install-update").disabled = true; byId("check-update").disabled = true;
    byId("update-message").textContent = "Downloading and verifying the app update. Your models stay here. The app will close and reopen when installation finishes.";
    try { await native.invoke("install_app_update"); }
    catch { installingUpdate = false; byId("start").disabled = false; byId("install-update").disabled = false; byId("check-update").disabled = false; byId("update-message").textContent = "The update could not finish. Your current app is still available. Try again when you are online and the app folder is writable."; }
  };
  native.invoke("app_update_settings").then((settings) => {
    byId("auto-updates").checked = settings.enabled;
    byId("update-token").placeholder = settings.hasToken ? "Access saved on this computer" : "GitHub token";
    if (settings.enabled) { void checkAppUpdates(); }
    else { byId("update-message").textContent = "Automatic checks are off. You can check for app updates here."; }
  }).catch(() => { byId("update-message").textContent = "Updates are unavailable. You can keep using the app offline."; });
}
