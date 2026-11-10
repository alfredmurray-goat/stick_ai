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
let lastUpdateFailed = false;
async function api(path, data) {
  const response = await fetch(path, { method: data ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}), cache: "no-store" });
  if (!response.ok) { const detail = await response.json().catch(() => ({})); throw new Error(detail.error || "The request could not finish. Try again."); }
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
      const url = await native.invoke("start_assistant", { faster, mode: byId("assistant-mode").value });
      location.replace(url);
    } catch { const state = await native.invoke("desktop_status").catch(() => ({})); showError(state.error); progress(null, false); byId("welcome").hidden = false; }
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
    byId("send").disabled = state.phase !== "ready" || state.repositoryBusy;
    byId("session-model").textContent = state.activeModel === "stellan-1-max" ? "Stellan-1 Max · code only" : state.paired ? "Stellan-1 Lite + Max · Lite runs tools, Max writes code" : "Stellan-1 Lite";
    renderRepository(state.repository, state.repositoryBusy || state.phase === "working" || state.phase === "starting");
    byId("start").disabled = false;
    progress(state.progress, ["starting", "working"].includes(state.phase));
    if (state.problem) { showError(state.problem); }
    for (const event of state.events) {
      after = event.id;
      if (["answer", "thinking", "coding"].includes(event.kind)) { message(event.text, event.kind); }
      if (event.kind === "project") { byId("messages").textContent = ""; byId("approvals").textContent = ""; byId("thinking").textContent = ""; byId("coding").textContent = ""; streaming = undefined; lastTask = ""; message(event.text, "status"); }
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
    byId("update-message").textContent = (lastUpdateFailed ? "The last update could not finish; your previous app was kept. " : "") + result.message + size;
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
    tokenInput.placeholder = settings.hasToken ? "Access saved on this computer" : "GitHub token";
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
    lastUpdateFailed = Boolean(settings.lastUpdateFailed);
    byId("auto-updates").checked = settings.enabled;
    byId("update-token").placeholder = settings.hasToken ? "Access saved on this computer" : "GitHub token";
    if (settings.enabled) { void checkAppUpdates(); }
    else { byId("update-message").textContent = "Automatic checks are off. You can check for app updates here."; }
  }).catch(() => { byId("update-message").textContent = "Updates are unavailable. You can keep using the app offline."; });
}

function showLocalModels(status) {
  byId("model-status").textContent = status.message;
  byId("assistant-mode").querySelector('[value="max"]').disabled = !(status.available && status.eligible);
  byId("assistant-mode").querySelector('[value="auto"]').textContent = status.available && status.eligible ? "Lite + Max (recommended)" : "Lite (Max unavailable on this computer)";
  byId("unlink-max").hidden = status.source !== "linked";
  if (status.path) { byId("max-path").value = status.path; }
  if (!(status.available && status.eligible) && byId("assistant-mode").value === "max") { byId("assistant-mode").value = "auto"; }
}
async function setLocalMax(action, path) {
  byId("start").disabled = true;
  for (const id of ["browse-max", "link-max", "unlink-max"]) { byId(id).disabled = true; }
  try { showLocalModels(await native.invoke(action, path === undefined ? {} : { path })); }
  catch (error) { byId("model-status").textContent = typeof error === "string" ? error : "The Max file could not be linked. Check the file and try again."; }
  finally { byId("start").disabled = false; for (const id of ["browse-max", "link-max", "unlink-max"]) { byId(id).disabled = false; } }
}
if (native) {
  byId("model-settings").hidden = false;
  native.invoke("local_model_status").then(showLocalModels).catch(() => { byId("model-status").textContent = "Max selection could not be read. Lite is still available."; });
  byId("link-max").onclick = () => setLocalMax("link_max_model", byId("max-path").value);
  byId("unlink-max").onclick = () => setLocalMax("unlink_max_model");
  byId("browse-max").onclick = async () => {
    try { const path = await native.invoke("choose_max_model"); if (path) { byId("max-path").value = path; await setLocalMax("link_max_model", path); } }
    catch (error) { byId("model-status").textContent = typeof error === "string" ? error : "Paste the full GGUF path, then choose Use this file."; }
  };
}

let repositoryBusy = false;
let repositoryReview;
let lastRepository;
function renderRepository(workspace, busy) {
  lastRepository = workspace;
  for (const id of ["github-connect", "github-disconnect", "github-resume", "github-review", "github-publish"]) byId(id).disabled = busy || repositoryBusy;
  byId("github-review").disabled ||= !workspace;
  byId("github-status").textContent = workspace ? `${workspace.repository} · ${workspace.branch} · ${workspace.commit.slice(0,12)} · ${workspace.authenticated ? "session token connected" : "public read access"}` : "Local project on this stick";
  if (workspace?.pullRequest) { byId("github-result").textContent = `Draft pull request: ${workspace.pullRequest.url} — copy this URL into your browser. Further reviewed changes update this pull-request branch.`; }
}
async function repositoryAction(action, data) {
  repositoryBusy = true; byId("github-cancel").hidden = false; renderRepository(lastRepository, true);
  byId("github-result").textContent = "Working with GitHub…";
  try { return await api(`/api/github/${action}`, data); }
  catch (error) { byId("github-result").textContent = error.message; throw error; }
  finally { repositoryBusy = false; byId("github-cancel").hidden = true; renderRepository(lastRepository, working); }
}
function clearRepositoryReview() { repositoryReview = undefined; byId("github-changes").textContent = ""; byId("github-publish-form").hidden = true; }
async function savedRepositories() {
  try {
    const value = await api("/api/github/workspaces"); const select = byId("github-saved"); select.replaceChildren();
    const empty = document.createElement("option"); empty.value = ""; empty.textContent = "Choose saved workspace"; select.append(empty);
    for (const item of value.workspaces) { const option = document.createElement("option"); option.value = item.id; option.textContent = `${item.repository} · ${item.branch} · ${item.id.slice(0,8)}`; select.append(option); }
  } catch (error) { byId("github-result").textContent = error.message; }
}
byId("github-connect").onclick = async () => {
  const token = byId("github-token").value; byId("github-token").value = "";
  try { const result = await repositoryAction("connect", {repository:byId("github-repo").value, branch:byId("github-branch").value, token}); clearRepositoryReview(); renderRepository(result.workspace, false); byId("github-result").textContent = "Connected. Ask the assistant to work on this repository."; await savedRepositories(); } catch {}
};
byId("github-resume").onclick = async () => {
  const token = byId("github-token").value; byId("github-token").value = "";
  try { const result = await repositoryAction("resume", {id:byId("github-saved").value, token}); clearRepositoryReview(); renderRepository(result.workspace, false); byId("github-result").textContent = "Saved files restored. Start a new task; chat history is not saved."; } catch {}
};
byId("github-disconnect").onclick = async () => { try { await repositoryAction("disconnect", {}); clearRepositoryReview(); renderRepository(null, false); byId("github-result").textContent = "Using the local project. Repository changes remain in Saved workspaces."; } catch {} };
byId("github-refresh").onclick = savedRepositories;
byId("github-cancel").onclick = () => api("/api/cancel", {}).catch(() => {});
byId("github-review").onclick = async () => {
  clearRepositoryReview();
  try {
    const result = await repositoryAction("review", {}); repositoryReview = result.digest;
    for (const change of result.changes) {
      const card = document.createElement("article"), title = document.createElement("h3"); title.textContent = `${change.kind}: ${change.path}`; card.append(title);
      if (change.binary) { const note = document.createElement("p"); note.textContent = "Binary file changed. Review the local file before publishing."; card.append(note); }
      else { for (const [label, content] of [["Before",change.before],["After",change.after]]) { const heading = document.createElement("h4"), text = document.createElement("pre"); heading.textContent = label; text.textContent = content; card.append(heading,text); } }
      if (change.truncated) { const note = document.createElement("p"); note.textContent = "Preview is shortened to 12,000 characters per version. Review the complete local file before publishing."; card.append(note); }
      byId("github-changes").append(card);
    }
    byId("github-result").textContent = result.changes.length ? `${result.changes.length} changed files. Publishing sends these changes to GitHub for a draft pull request.` : "No changes to publish.";
    byId("github-publish").textContent = result.workspace?.pullRequest ? "Update pull-request branch" : "Create draft pull request";
    byId("github-publish-form").hidden = !result.changes.length || result.alreadyPublished;
  } catch {}
};
byId("github-publish").onclick = async () => {
  if (!repositoryReview) return;
  try { const result = await repositoryAction("publish", {digest:repositoryReview,title:byId("github-title").value,body:byId("github-body").value}); byId("github-result").textContent = `Draft pull request: ${result.url} — copy this URL into your browser.`; clearRepositoryReview(); } catch {}
};
if (!native) void savedRepositories();
