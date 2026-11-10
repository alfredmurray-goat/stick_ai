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
  byId("live-indicator").textContent = busy ? "● LIVE" : "○ IDLE";
  document.body.classList.toggle("awaiting-approval", view?.message === "Waiting for your approval");
  byId("ready-label").textContent = busy ? "Working" : native ? "Not started" : "Ready";
  byId("ready-dot").classList.toggle("pulse", busy);
  byId("thinking-state").textContent = busy ? byId("thinking").textContent ? "STREAMING" : "WAITING" : byId("thinking").textContent ? "COMPLETE" : "READY";
  byId("new-session").disabled = busy || Boolean(native);
  if (byId("file-editor")) byId("file-editor").readOnly = busy || repositoryBusy || savingFile;
  if (typeof updateEditorState === "function") updateEditorState();
  byId("status").textContent = view?.message || "Thinking...";
  byId("elapsed").textContent = view?.elapsedSeconds == null ? "" : ` ${view.elapsedSeconds} seconds`;
  byId("reassurance").textContent = view?.reassurance || "";
}
function scrollConversation(force = false) {
  const panel = byId("conversation-scroll");
  if (force || panel.scrollHeight - panel.scrollTop - panel.clientHeight < 160) requestAnimationFrame(() => { panel.scrollTop = panel.scrollHeight; });
}
function message(text, kind = "answer") {
  if (!text) return;
  if (kind === "thinking" || kind === "coding") {
    byId(kind === "thinking" ? "thoughts" : "code-preview").hidden = false;
    const target = byId(kind); const follow = target.scrollHeight - target.scrollTop - target.clientHeight < 60;
    target.textContent += text;
    if (kind === "thinking") { byId("thinking-empty").hidden = true; byId("thinking-state").textContent = working ? "STREAMING" : "COMPLETE"; }
    if (follow) target.scrollTop = target.scrollHeight;
    return;
  }
  byId("chat-empty").hidden = true; document.body.classList.add("has-conversation");
  if (!streaming || streamKind !== kind) {
    const card = document.createElement("article"); card.className = `message ${kind}`;
    const label = document.createElement("div"); label.className = `message-label ${kind === "answer" ? "assistant-label" : ""}`; label.textContent = kind === "you" ? "YOU" : kind === "answer" ? "STELLAN" : "WORKSPACE";
    streaming = document.createElement("pre"); card.append(label, streaming); byId("messages").append(card); streamKind = kind;
  }
  streaming.textContent += text; scrollConversation(kind === "you");
}
async function start(faster = false) {
  if (installingUpdate) { return; }
  byId("app-updates").hidden = true;
  retryStart = true; byId("error").hidden = true; byId("start").disabled = true;
  if (native) {
    nativeStarting = true; nativeStarted = Date.now(); byId("welcome").hidden = true; byId("loading").hidden = false;
    progress({ message: "Starting your private assistant..." }, true);
    try {
      const url = await native.invoke("start_assistant", { faster, mode: byId("assistant-mode").value });
      location.replace(url);
    } catch { const state = await native.invoke("desktop_status").catch(() => ({})); showError(state.error); progress(null, false); byId("loading").hidden = true; byId("welcome").hidden = false; }
    finally { nativeStarting = false; byId("start").disabled = false; }
  } else {
    try { await api(faster ? "/api/faster" : "/api/start", faster ? {} : { model: "stellan-1-lite" }); }
    catch { showError(); byId("start").disabled = false; }
  }
}
function beginTurn(text) {
  if (innerWidth > 620) inspectorTab(false);
  if (byId("thinking").textContent) { const card = document.createElement("details"), summary = document.createElement("summary"), content = document.createElement("pre"); card.className = "message reasoning-history"; summary.textContent = "Previous turn · thinking"; content.textContent = byId("thinking").textContent; card.append(summary, content); byId("messages").append(card); }
  streaming = undefined; message(text, "you"); streaming = undefined;
  toolCards.clear(); byId("tool-activity").textContent = ""; byId("tool-count").textContent = "0";
  byId("thinking-empty").hidden = false; byId("thinking-empty").textContent = "Waiting for the model’s reasoning stream. Tool activity appears below.";
  for (const id of ["thinking", "coding"]) { byId(id).textContent = ""; }
  byId("thoughts").open = true; byId("thoughts").hidden = false; byId("code-preview").hidden = true;
}
async function task(text) {
  if (!text.trim() || working || repositoryBusy || native) { return; }
  if (hasUnsavedFile()) { toast("Save or discard your file edits before starting a task."); return; }
  retryStart = false; lastTask = text; byId("error").hidden = true;
  byId("prompt").value = "";
  try { byId("send").disabled = true; await api("/api/task", { text }); } catch (error) { showError({message:error.message}); }
}
byId("start").onclick = () => start();
byId("question").onsubmit = (event) => { event.preventDefault(); void task(byId("prompt").value); };

byId("cancel").onclick = () => { void (native ? native.invoke("cancel_start") : api("/api/cancel", {})).catch(() => {}); };
document.addEventListener("keydown", (event) => { if (working && !byId("settings-dialog").open && (event.key === "Escape" || event.ctrlKey && event.key.toLowerCase() === "c" && !window.getSelection()?.toString())) { event.preventDefault(); byId("cancel").click(); } });
byId("error-action").onclick = async () => {
  byId("error").hidden = true;
  if (errorAction === "OK") { if (!native) { await api("/api/dismiss", {}).catch(() => {}); } else { byId("welcome").hidden = false; } return; }
  if (errorAction === "Switch to a faster setting") { await start(true); return; }
  if (retryStart) { await start(); } else { await task(lastTask); }
};
byId("stop").onclick = () => { if (hasUnsavedFile()) { toast("Save or discard your file edits before closing."); return; } void api("/api/stop", {}).catch(() => {}); };
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
    byId("composer-area").hidden = byId("chat").hidden;
    byId("project-name").textContent = state.project?.name || "Local project";
    byId("project-name").title = state.project?.location || "";
    byId("workspace-title").textContent = state.repository?.repository || "Local project";
    byId("branch-label").textContent = state.repository?.branch || "local";
    if (!filesLoaded && state.phase === "ready") void refreshFiles();
    byId("stop").hidden = state.desktop;
    byId("send").disabled = state.phase !== "ready" || state.repositoryBusy;
    byId("session-model").textContent = state.activeModel === "stellan-1-max" ? "Stellan-1 Max · code only" : state.paired ? "Stellan-1 Lite + Max · Lite runs tools, Max writes code" : "Stellan-1 Lite";
    renderRepository(state.repository, state.repositoryBusy || state.phase === "working" || state.phase === "starting");
    byId("start").disabled = false;
    progress(state.progress, ["starting", "working"].includes(state.phase));
    if (state.problem) { showError(state.problem); byId("ready-label").textContent = "Needs attention"; }
    for (const event of state.events) {
      after = event.id;
      if (event.kind === "user") { beginTurn(event.text); }
      if (event.kind === "approval-resolved") { for (const card of byId("approvals").children) if (card.dataset.approval === event.data.id) card.remove(); }
      if (["answer", "thinking", "coding"].includes(event.kind)) { message(event.text, event.kind); }
      if (event.kind === "project") { projectEpoch++; expandedFolders.clear(); clearEditor(); filesLoaded = false; toolCards.clear(); byId("tool-activity").textContent = ""; byId("tool-count").textContent = "0"; byId("messages").textContent = ""; byId("approvals").textContent = ""; byId("thinking").textContent = ""; byId("coding").textContent = ""; streaming = undefined; lastTask = ""; if (event.text.startsWith("New conversation")) { byId("chat-empty").hidden = false; } else message(event.text, "status"); }
      if (event.kind === "tool") { renderTool(event.data); }
      if (event.kind === "task-complete") { byId("thinking-empty").textContent = byId("thinking").textContent ? "" : "This response did not emit separate reasoning. See the tool activity below."; void refreshFiles(); }
      if (event.kind === "file-saved") { void refreshFiles(); }
      if (event.kind === "status") { byId("status").textContent = event.text; }
      if (event.kind === "problem") { showError(event.data); }
      if (event.kind === "approval") {
        const card = document.createElement("article"); card.className = "approval-card"; card.dataset.approval = event.data.id; const title = document.createElement("h3"); title.textContent = `Save changes to ${event.data.file}?`;
        const preview = document.createElement("pre"); preview.textContent = event.data.after; card.append(title, preview); const actions = document.createElement("div"); actions.className = "approval-actions"; card.append(actions);
        for (const [label, allow] of [["Allow changes", true], ["Keep my file", false]]) {
          const button = document.createElement("button"); button.textContent = label; button.className = allow ? "primary" : "secondary";
          button.onclick = async () => { try { await api("/api/approve", { id: event.data.id, allow }); card.remove(); } catch { showError(); } }; actions.append(button);
        }
        byId("approvals").append(card); if (innerWidth <= 620) document.body.classList.remove("inspector-open"); scrollConversation(true);
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
  byId("model-status").textContent = status.message; byId("max-quick-status").textContent = status.message;
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
  if (hasUnsavedFile()) { toast("Save or discard your file edits before switching workspaces."); return; }
  const token = byId("github-token").value; byId("github-token").value = "";
  try { const result = await repositoryAction("connect", {repository:byId("github-repo").value, branch:byId("github-branch").value, token}); clearRepositoryReview(); renderRepository(result.workspace, false); byId("github-result").textContent = "Connected. Ask the assistant to work on this repository."; await savedRepositories(); } catch {}
};
byId("github-resume").onclick = async () => {
  if (hasUnsavedFile()) { toast("Save or discard your file edits before switching workspaces."); return; }
  const token = byId("github-token").value; byId("github-token").value = "";
  try { const result = await repositoryAction("resume", {id:byId("github-saved").value, token}); clearRepositoryReview(); renderRepository(result.workspace, false); byId("github-result").textContent = "Saved files restored. Start a new task; chat history is not saved."; } catch {}
};
byId("github-disconnect").onclick = async () => { if (hasUnsavedFile()) { toast("Save or discard your file edits before switching workspaces."); return; } try { await repositoryAction("disconnect", {}); clearRepositoryReview(); renderRepository(null, false); byId("github-result").textContent = "Using the local project. Repository changes remain in Saved workspaces."; } catch {} };
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

const toolCards = new Map();
let filesLoaded = false;
let filesLoading = false;
let projectEpoch = 0;
let fileRequest = 0;
let currentFile = "";
let originalFile = "";
let savingFile = false;
const expandedFolders = new Set();
function toast(text) { byId("toast").textContent = text; byId("toast").hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { byId("toast").hidden = true; }, 3500); }
function openSettings(tab = "models") {
  for (const button of document.querySelectorAll("[data-settings]")) button.classList.toggle("active", button.dataset.settings === tab);
  for (const name of ["models","github","updates"]) byId(`settings-${name}`).hidden = name !== tab;
  byId("github-panel").open = true;
  if (!byId("settings-dialog").open) byId("settings-dialog").showModal();
}
byId("open-settings").onclick = () => openSettings("models");
byId("open-github").onclick = () => openSettings("github");
byId("open-updates").onclick = () => openSettings("updates");
byId("quick-max").onclick = () => { openSettings("models"); byId("max-selection").open = true; };
byId("close-settings").onclick = () => byId("settings-dialog").close();
for (const button of document.querySelectorAll("[data-settings]")) button.onclick = () => openSettings(button.dataset.settings);
byId("theme-toggle").onclick = () => { document.documentElement.classList.toggle("light"); try { localStorage.setItem("stick-theme", document.documentElement.classList.contains("light") ? "light" : "dark"); } catch {} };
try { document.documentElement.classList.toggle("light", localStorage.getItem("stick-theme") === "light"); } catch {}
byId("sidebar-toggle").onclick = () => { if (innerWidth <= 860) document.body.classList.toggle("sidebar-open"); else document.body.classList.toggle("sidebar-hidden"); };
byId("activity-toggle").onclick = () => { if (innerWidth <= 620) document.body.classList.toggle("inspector-open"); else document.body.classList.toggle("inspector-hidden"); };
function inspectorTab(file) { byId("activity-panel").hidden = file; byId("file-panel").hidden = !file; byId("tab-file").classList.toggle("active", file); byId("tab-activity").classList.toggle("active", !file); document.body.classList.remove("inspector-hidden"); if (innerWidth <= 620) document.body.classList.add("inspector-open"); }
byId("tab-file").onclick = () => inspectorTab(true); byId("tab-activity").onclick = () => inspectorTab(false);
function renderTool(data) {
  let card = toolCards.get(data.step);
  if (!card) {
    if (!toolCards.size) byId("tool-activity").textContent = "";
    card = document.createElement("div"); card.className = "tool-card";
    const title = document.createElement("strong"); title.textContent = ({read_file:"Read file",list_dir:"Explore files",search_files:"Search project",write_file:"Write file",edit_file:"Edit file",delegate_code:"Hand off to Max",run_shell:"Command request"})[data.tool] || data.tool;
    const path = document.createElement("span"); path.className = "tool-path"; path.textContent = data.path || data.detail || "Project workspace";
    card.append(title,path); byId("tool-activity").append(card); toolCards.set(data.step,card); byId("tool-count").textContent = String(toolCards.size);
  }
  if (data.phase === "finish") {
    card.classList.add(data.result?.startsWith("Error:") || data.result === "Denied by user" ? "failed" : "complete");
    const details = document.createElement("details"), summary = document.createElement("summary"), content = document.createElement("pre"); summary.textContent = "Result"; content.textContent = data.result || "Finished"; details.append(summary,content); card.append(details);
    if (["write_file","edit_file"].includes(data.tool)) { void refreshFiles(); void reloadCurrentFile(data.path); }
  }
}
async function fileEntries(parent,path) {
  const result = await api(`/api/files?path=${encodeURIComponent(path || ".")}`);
  for (const entry of result.entries) {
    const relative = path ? `${path}/${entry.name}` : entry.name;
    const button = document.createElement("button"), icon = document.createElement("span"), name = document.createElement("span"); button.className = "file-entry"; button.title = relative; icon.className = "file-icon"; icon.textContent = entry.directory ? "▸" : "·"; name.textContent = entry.name; button.append(icon,name); parent.append(button);
    if (entry.directory) {
      const children = document.createElement("div"); children.className = "file-children"; children.hidden = true; parent.append(children);
      const expand = async () => { if (children.hidden) { children.textContent = ""; await fileEntries(children,relative); children.hidden = false; expandedFolders.add(relative); icon.textContent = "▾"; } else { children.hidden = true; expandedFolders.delete(relative); icon.textContent = "▸"; } };
      button.onclick = () => expand().catch(error => toast(error.message));
      if (expandedFolders.has(relative)) await expand();
    } else button.onclick = () => openFile(relative);
  }
  if (!result.entries.length) { const empty = document.createElement("p"); empty.className = "empty-files"; empty.textContent = path ? "Empty folder" : "No files yet. Ask Stellan to create something."; parent.append(empty); }
  if (result.truncated) { const note = document.createElement("p"); note.className = "empty-files"; note.textContent = "Showing the first 1,000 entries."; parent.append(note); }
}
async function refreshFiles() {
  if (native || filesLoading) return; filesLoading = true; const epoch = projectEpoch;
  try { const tree = document.createElement("div"); await fileEntries(tree,""); if (epoch === projectEpoch) { byId("file-tree").replaceChildren(tree); filesLoaded = true; } }
  catch (error) { byId("file-tree").textContent = "Files are temporarily unavailable. Refresh to try again."; }
  finally { filesLoading = false; if (epoch !== projectEpoch) void refreshFiles(); }
}
byId("refresh-files").onclick = refreshFiles;
function hasUnsavedFile() { return Boolean(currentFile && byId("file-editor").value !== originalFile); }
async function reloadCurrentFile(path) { if (!currentFile || path?.replace(/^\.\//, "") !== currentFile || hasUnsavedFile() || savingFile) return; const selected = currentFile, epoch = projectEpoch, requestId = fileRequest; try { const value = await api(`/api/file?path=${encodeURIComponent(selected)}`); if (currentFile === selected && epoch === projectEpoch && requestId === fileRequest && !hasUnsavedFile()) { originalFile = value.content; byId("file-editor").value = value.content; byId("file-status").textContent = "Updated by Stellan"; updateEditorState(); } } catch {} }
function updateEditorState() { const dirty = currentFile && byId("file-editor").value !== originalFile; byId("save-file").disabled = !dirty || savingFile || working || repositoryBusy; byId("discard-file").disabled = !dirty || savingFile; if (dirty && !savingFile) byId("file-status").textContent = "Unsaved changes"; }
function clearEditor() { fileRequest++; currentFile = ""; originalFile = ""; byId("file-title").textContent = "No file selected"; byId("file-editor").value = ""; byId("file-editor").disabled = true; byId("file-status").textContent = "Choose a project file."; updateEditorState(); }
async function openFile(path) {
  if (currentFile && byId("file-editor").value !== originalFile) { toast("Save or discard your file edits before opening another file."); return; }
  const requestId = ++fileRequest, epoch = projectEpoch;
  try { const result = await api(`/api/file?path=${encodeURIComponent(path)}`); if (requestId !== fileRequest || epoch !== projectEpoch) return; if (hasUnsavedFile()) { toast("Your unsaved edits were kept. Save or discard them before switching files."); return; } currentFile = result.path; originalFile = result.content; byId("file-title").textContent = path; byId("file-title").title = path; byId("file-editor").value = result.content; byId("file-editor").disabled = false; byId("file-editor").readOnly = working; byId("file-status").textContent = "Saved on this stick"; updateEditorState(); inspectorTab(true); document.body.classList.remove("sidebar-open"); }
  catch (error) { toast("Could not open this file. Text files under 1 MiB are supported."); }
}
byId("file-editor").oninput = updateEditorState;
byId("discard-file").onclick = () => { byId("file-editor").value = originalFile; byId("file-status").textContent = "Edits discarded"; updateEditorState(); };
byId("save-file").onclick = async () => {
  if (!currentFile || working || repositoryBusy || savingFile) return;
  savingFile = true; updateEditorState(); const path = currentFile, content = byId("file-editor").value;
  try { await api("/api/file", {path,content}); originalFile = content; byId("file-status").textContent = "Saved on this stick"; toast("File saved"); void refreshFiles(); }
  catch (error) { toast("File could not be saved. Your edits are still in the editor."); }
  finally { savingFile = false; updateEditorState(); }
};
byId("copy-file").onclick = async () => { if (!currentFile) return; try { await navigator.clipboard.writeText(byId("file-editor").value); toast("File copied"); } catch { toast("Select the file text and copy it with your keyboard."); } };
byId("new-session").onclick = async () => {
  if (native || working || repositoryBusy) return;
  if (currentFile && byId("file-editor").value !== originalFile) { toast("Save or discard your file edits first."); return; }
  try { await api("/api/session/reset",{}); byId("messages").textContent = ""; byId("chat-empty").hidden = false; byId("thinking").textContent = ""; byId("coding").textContent = ""; byId("thinking-empty").hidden = false; byId("thinking-empty").textContent = "Model reasoning will stream here. Some responses do not emit separate reasoning."; byId("prompt").focus(); } catch (error) { toast(error.message); }
};
byId("local-project").onclick = () => { if (native) return; if (lastRepository) byId("github-disconnect").click(); else void refreshFiles(); };
byId("prompt").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!byId("send").disabled) byId("question").requestSubmit(); } });
byId("prompt").addEventListener("input", () => { byId("prompt").style.height = "auto"; byId("prompt").style.height = Math.min(230,byId("prompt").scrollHeight) + "px"; });
document.addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); byId("new-session").click(); } });
for (const button of document.querySelectorAll("[data-prompt]")) button.onclick = () => { byId("prompt").value = button.dataset.prompt; byId("prompt").focus(); };
if (native) {
  byId("new-session").disabled = true;
  for (const id of ["github-connect","github-resume","github-review","github-disconnect","github-refresh","github-publish"]) byId(id).disabled = true;
  byId("github-result").textContent = "Open the workspace first, then connect your repository here.";
} else { byId("quick-max").hidden = true; byId("running-model-note").hidden = false; byId("running-update-note").hidden = false; }

const shortcutHint = document.querySelector("#new-session kbd"); if (shortcutHint) shortcutHint.textContent = /Mac/.test(navigator.platform) ? "⌘ N" : "Ctrl N";

window.addEventListener("beforeunload", event => { if (hasUnsavedFile()) { event.preventDefault(); event.returnValue = ""; } });
document.addEventListener("click", event => { if (document.body.classList.contains("sidebar-open") && !event.target.closest(".sidebar") && !event.target.closest("#sidebar-toggle")) document.body.classList.remove("sidebar-open"); });
