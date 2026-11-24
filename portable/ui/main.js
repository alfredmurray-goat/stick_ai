const localWeb = location.protocol === "http:" && location.hostname === "127.0.0.1";
const launchToken = localWeb && /^[a-f0-9]{64}$/.test(location.hash.slice(1)) ? location.hash.slice(1) : "";
let token = launchToken;
if (localWeb) {
  // The loopback credential is scoped to this tab and running app session.
  // GitHub access tokens are never stored here.
  try { if (launchToken) sessionStorage.setItem("stick-session", launchToken); else token = sessionStorage.getItem("stick-session") || ""; } catch {}
}
const native = !localWeb && window.__TAURI__?.core;
if (launchToken) { history.replaceState(null, "", "/"); }
const byId = (id) => document.getElementById(id);
let after = 0;
let streaming;
let streamKind;
let working = false;
let lastTask = "";
let lastTaskAttachments = [];
let retryStart = true;
let nativeStarted = 0;
let errorAction = "Retry";
let polling = false;
let internetAllowed = null, autoCheckPending = false;
let stateKey = "";
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
  // On the welcome screen the card sits below the fold; a failed start must never look like nothing happened.
  requestAnimationFrame(() => byId("error").scrollIntoView({ block: "center", behavior: "smooth" }));
  toast(byId("error-message").textContent);
}
function progress(view, busy) {
  working = busy; byId("progress").hidden = !busy; document.body.classList.toggle("working", busy);
  if (!busy) finishStreaming();
  byId("live-indicator").textContent = busy ? "● LIVE" : "○ IDLE";
  document.body.classList.toggle("awaiting-approval", view?.message === "Waiting for your approval");
  byId("ready-label").textContent = busy ? "Working" : native ? "Not started" : "Ready";
  byId("ready-dot").classList.toggle("pulse", busy);
  byId("thinking-state").textContent = busy ? byId("thinking").textContent ? "STREAMING" : "WAITING" : byId("thinking").textContent ? "COMPLETE" : "READY";
  byId("new-session").disabled = busy || Boolean(native);
  if (byId("file-editor")) byId("file-editor").readOnly = busy || repositoryBusy || savingFile;
  if (typeof updateEditorState === "function") updateEditorState();
  byId("status").textContent = view?.message || "Thinking...";
  if (busy) turnProgress(view?.message || "Thinking..."); else finishTurnActivity();
  byId("elapsed").textContent = view?.elapsedSeconds == null ? "" : ` ${view.elapsedSeconds} seconds`;
  byId("reassurance").textContent = view?.reassurance || "";
}
function scrollConversation(force = false) {
  const panel = byId("conversation-scroll");
  if (force || panel.scrollHeight - panel.scrollTop - panel.clientHeight < 160) requestAnimationFrame(() => { panel.scrollTop = panel.scrollHeight; });
}
// ---------- Icons and safe markdown rendering ----------
// Everything below builds DOM nodes with textContent; model output is never parsed as HTML.
const SVG = "http://www.w3.org/2000/svg";
function icon(name) {
  const svg = document.createElementNS(SVG, "svg"), use = document.createElementNS(SVG, "use");
  svg.setAttribute("class", "i"); svg.setAttribute("aria-hidden", "true"); use.setAttribute("href", `#i-${name}`); svg.append(use); return svg;
}
const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|(?<![\w_])__(?=\S)([\s\S]*?\S)__(?![\w_])|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)|(?<![\w_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w_])|\[([^\]\n]+)\]\((\S+?)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
function appendText(parent, text) {
  const parts = text.split("\n");
  parts.forEach((part, index) => { if (index) parent.append(document.createElement("br")); if (part) parent.append(part); });
}
function inline(parent, text) {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    appendText(parent, text.slice(last, match.index)); last = match.index + match[0].length;
    if (match[1]) { const code = document.createElement("code"); code.textContent = match[2].replace(/^ (.*) $/, "$1"); parent.append(code); }
    else if (match[3] ?? match[4]) { const node = document.createElement("strong"); inline(node, match[3] ?? match[4]); parent.append(node); }
    else if (match[5]) { const node = document.createElement("del"); inline(node, match[5]); parent.append(node); }
    else if (match[6] ?? match[7]) { const node = document.createElement("em"); inline(node, match[6] ?? match[7]); parent.append(node); }
    else { const url = match[9] ?? match[10]; const node = document.createElement("span"); node.className = "md-link"; node.dataset.url = url; node.title = `${url} · click to copy`; node.tabIndex = 0; node.setAttribute("role", "button"); if (match[8]) inline(node, match[8]); else node.textContent = url; parent.append(node); }
  }
  appendText(parent, text.slice(last));
}
function codeBlock(code, language) {
  const block = document.createElement("div"), head = document.createElement("div"), lang = document.createElement("span"), copy = document.createElement("button"), pre = document.createElement("pre"), body = document.createElement("code");
  block.className = "code-block"; head.className = "code-head"; lang.className = "code-lang"; lang.textContent = language || "code";
  copy.type = "button"; copy.className = "copy-button"; copy.setAttribute("aria-label", "Copy code"); copy.append(icon("copy"), "Copy");
  if (window.stickHighlight) { window.stickHighlight.highlightInto(body, code, language); } else { body.textContent = code; }
  pre.append(body); head.append(lang, copy); block.append(head, pre); return block;
}
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const BLOCK_START = /^\s*(#{1,6}\s|```|~~~|>|([-*_])(\s*\2){2,}\s*$)/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
function tableCells(line) { return line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|")); }
function renderList(lines, start, parent) {
  const first = lines[start].match(LIST_ITEM); const indent = first[1].length; const ordered = /\d/.test(first[2]);
  const list = document.createElement(ordered ? "ol" : "ul"); if (ordered && parseInt(first[2], 10) !== 1) list.start = parseInt(first[2], 10);
  let index = start; let item;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      let next = index + 1; while (next < lines.length && !lines[next].trim()) next++;
      const upcoming = lines[next]?.match(LIST_ITEM);
      if (upcoming && upcoming[1].length >= indent) { index = next; continue; }
      break;
    }
    const match = line.match(LIST_ITEM);
    if (match && match[1].length > indent && item) { index = renderList(lines, index, item); continue; }
    if (match && match[1].length <= indent) {
      if (match[1].length < indent || /\d/.test(match[2]) !== ordered) break;
      item = document.createElement("li"); inline(item, match[3]); list.append(item); index++; continue;
    }
    if (!match && item && !BLOCK_START.test(line)) { inline(item, " " + line.trim()); index++; continue; }
    break;
  }
  parent.append(list); return index;
}
function renderMarkdown(target, source) {
  const root = document.createDocumentFragment(); const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph = []; let index = 0;
  const flush = () => { if (!paragraph.length) return; const p = document.createElement("p"); inline(p, paragraph.join("\n")); root.append(p); paragraph = []; };
  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/);
    if (fence) {
      flush(); const body = []; index++;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      index++; root.append(codeBlock(body.join("\n"), fence[2])); continue;
    }
    if (!line.trim()) { flush(); index++; continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) { flush(); const node = document.createElement(`h${Math.min(4, heading[1].length)}`); inline(node, heading[2]); root.append(node); index++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); root.append(document.createElement("hr")); index++; continue; }
    if (/^\s*>/.test(line)) {
      flush(); const body = []; while (index < lines.length && /^\s*>/.test(lines[index])) body.push(lines[index++].replace(/^\s*>\s?/, ""));
      const quote = document.createElement("blockquote"); renderMarkdown(quote, body.join("\n")); root.append(quote); continue;
    }
    if (LIST_ITEM.test(line) && (!paragraph.length || /^\s*([-*+]|1[.)])\s/.test(line))) { flush(); index = renderList(lines, index, root); continue; }
    if (line.includes("|") && TABLE_RULE.test(lines[index + 1] ?? "")) {
      flush(); const table = document.createElement("table"), head = document.createElement("thead"), body = document.createElement("tbody"), row = document.createElement("tr");
      for (const cell of tableCells(line)) { const th = document.createElement("th"); inline(th, cell); row.append(th); }
      head.append(row); index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) { const tr = document.createElement("tr"); for (const cell of tableCells(lines[index])) { const td = document.createElement("td"); inline(td, cell); tr.append(td); } body.append(tr); index++; }
      table.append(head, body); root.append(table); continue;
    }
    paragraph.push(line); index++;
  }
  flush(); target.replaceChildren(root);
}
const pendingRenders = new Set();
function scheduleRender(target) {
  if (!pendingRenders.size) requestAnimationFrame(() => {
    for (const node of pendingRenders) { renderMarkdown(node, node.raw); if (node.classList.contains("live")) addCursor(node); }
    pendingRenders.clear(); scrollConversation();
  });
  pendingRenders.add(target);
}
function addCursor(node) {
  let target = node.lastElementChild;
  while (target && ["UL", "OL", "BLOCKQUOTE"].includes(target.tagName) && target.lastElementChild) target = target.lastElementChild;
  const cursor = document.createElement("span"); cursor.className = "streaming-cursor"; cursor.setAttribute("aria-hidden", "true");
  (target && !target.classList.contains("code-block") && target.tagName !== "TABLE" ? target : node).append(cursor);
}
function finishStreaming() {
  for (const node of document.querySelectorAll(".md.live")) { node.classList.remove("live"); scheduleRender(node); }
}
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) { button.classList.add("copied"); button.lastChild.textContent = "Copied"; button.firstChild.replaceWith(icon("check")); setTimeout(() => { button.classList.remove("copied"); button.lastChild.textContent = "Copy"; button.firstChild.replaceWith(icon("copy")); }, 1600); }
    return true;
  } catch { toast("Select the text and copy it with your keyboard."); return false; }
}
document.addEventListener("click", (event) => {
  const copy = event.target.closest(".copy-button");
  if (copy) { void copyText(copy.closest(".code-block").querySelector("pre").textContent, copy); return; }
  const link = event.target.closest(".md-link");
  if (link) { void copyText(link.dataset.url).then((ok) => { if (ok) toast("Link copied. Paste it into your browser to open it."); }); }
});
document.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && event.target.classList?.contains("md-link")) { event.preventDefault(); event.target.click(); } });

let thinkingBreak = false;
// ---------- Inline activity: what Stellan is doing for this message, shown in the conversation ----------
// A live row appears as soon as a message is sent (so the chat is never blank while the model reads),
// streams the model's thinking and each tool step, then folds into "Thought for 12 s · 2 steps".
let turn;
function turnActivity() {
  if (turn?.card.isConnected) return turn;
  const card = document.createElement("details"), summary = document.createElement("summary"), spinner = document.createElement("span"), title = document.createElement("span"), meta = document.createElement("span"), body = document.createElement("div");
  card.className = "message turn-activity live"; spinner.className = "turn-spinner"; title.className = "turn-title"; meta.className = "turn-meta"; body.className = "turn-body";
  title.textContent = "Starting..."; summary.append(spinner, title, meta, icon("chevron")); card.append(summary, body);
  summary.addEventListener("click", () => { if (turn?.card === card) turn.touched = true; });
  byId("chat-empty").hidden = true; byId("messages").append(card);
  turn = { card, title, meta, body, started: Date.now(), steps: new Map(), thought: false, touched: false, done: false };
  scrollConversation(); return turn;
}
function turnProgress(text) {
  if (!turn || turn.done || !turn.card.isConnected) return;
  turn.title.textContent = text; turn.meta.textContent = `${Math.max(1, Math.round((Date.now() - turn.started) / 1000))} s`;
}
function turnThought(text, newParagraph) {
  const t = turnActivity(); let paragraph = t.body.lastElementChild;
  if (!paragraph?.classList.contains("turn-thought") || newParagraph) { paragraph = document.createElement("p"); paragraph.className = "turn-thought"; t.body.append(paragraph); text = text.replace(/^\s+/, ""); }
  paragraph.textContent += text; t.thought = true;
  if (!t.touched && !t.done) t.card.open = true;
  if (t.card.open) t.body.scrollTop = t.body.scrollHeight;
  scrollConversation();
}
function turnStep(data, title, iconName) {
  const t = turnActivity(); let row = t.steps.get(data.step);
  if (!row) {
    row = document.createElement("div"); row.className = "turn-step"; const name = document.createElement("strong"), where = document.createElement("span");
    name.textContent = title; where.textContent = [".", "./", ""].includes(data.path ?? "") ? data.detail || "Project root" : data.path; for (const [id, label] of mcpNames) where.textContent = where.textContent.replace(id, label);
    row.append(icon(iconName), name, where); t.body.append(row); t.steps.set(data.step, row); scrollConversation();
  }
  if (data.phase === "finish") row.classList.add(data.result?.startsWith("Error:") || data.result === "Denied by user" ? "failed" : "complete");
}
function closeTurnActivity() { if (turn && !turn.touched) turn.card.open = false; }
function finishTurnActivity() {
  if (!turn || turn.done) return; const t = turn; t.done = true; t.card.classList.remove("live");
  if (!t.thought && !t.steps.size) { t.card.remove(); return; }
  const seconds = Math.max(1, Math.round((Date.now() - t.started) / 1000)), steps = t.steps.size;
  t.title.textContent = t.thought ? `Thought for ${seconds} s` : `Worked for ${seconds} s`; t.meta.textContent = steps ? `${steps} step${steps === 1 ? "" : "s"}` : "";
  if (!t.touched) t.card.open = false;
}
function message(text, kind = "answer") {
  if (!text) return;
  if (kind === "thinking") turnThought(text, thinkingBreak);
  if (kind === "answer") closeTurnActivity();
  if (kind === "thinking" || kind === "coding") {
    byId(kind === "thinking" ? "thoughts" : "code-preview").hidden = false;
    const target = byId(kind); const follow = target.scrollHeight - target.scrollTop - target.clientHeight < 60;
    if (kind === "thinking" && thinkingBreak && target.textContent && !/\n\s*$/.test(target.textContent)) text = "\n\n" + text.replace(/^\s+/, "");
    if (kind === "thinking") thinkingBreak = false;
    target.textContent += text;
    if (kind === "thinking") { byId("thinking-empty").hidden = true; byId("thinking-state").textContent = working ? "STREAMING" : "COMPLETE"; }
    if (follow) target.scrollTop = target.scrollHeight;
    return;
  }
  byId("chat-empty").hidden = true; document.body.classList.add("has-conversation");
  if (!streaming || streamKind !== kind) {
    const card = document.createElement("article"); card.className = `message ${kind}`;
    const label = document.createElement("div"); label.className = `message-label ${kind === "answer" ? "assistant-label" : ""}`; label.textContent = kind === "you" ? "YOU" : kind === "answer" ? "STELLAN" : "WORKSPACE";
    if (kind === "answer") { streaming = document.createElement("div"); streaming.className = "md live"; streaming.raw = ""; }
    else streaming = document.createElement("pre");
    card.append(label, streaming); byId("messages").append(card); streamKind = kind;
  }
  if (kind === "answer") { streaming.raw += text; scheduleRender(streaming); return; }
  streaming.textContent += text; scrollConversation(kind === "you");
}
async function start(faster = false) {
  if (installingUpdate) { return; }
  // A model-free copy has nothing to start until Lite is linked: say so instead of ignoring the click.
  if (native && !liteReady) { toast("Choose your Stellan-1 Lite GGUF first. This download has no model files inside."); byId("quick-lite").click(); return; }
  retryStart = true; byId("error").hidden = true; byId("start").disabled = true; byId("install-update").disabled = true;
  if (native) {
    nativeStarting = true; nativeStarted = Date.now(); byId("welcome").hidden = true; byId("loading").hidden = false;
    progress({ message: "Starting your private assistant..." }, true);
    try {
      const url = await native.invoke("start_assistant", { faster, mode: byId("assistant-mode").value });
      location.replace(url);
    } catch { const state = await native.invoke("desktop_status").catch(() => ({})); showError(state.error); progress(null, false); byId("loading").hidden = true; byId("welcome").hidden = false; }
    finally { nativeStarting = false; byId("start").disabled = false; byId("install-update").disabled = false; }
  } else {
    try { await api(faster ? "/api/faster" : "/api/start", faster ? {} : { model: "stellan-1-lite" }); }
    catch { showError(); byId("start").disabled = false; }
  }
}
function beginTurn(text) {
  if (innerWidth > 620) inspectorTab(false);
  finishStreaming(); finishTurnActivity(); thinkingBreak = false;
  streaming = undefined; message(text, "you"); streaming = undefined; turnActivity();
  toolCards.clear(); byId("tool-activity").textContent = ""; byId("tool-count").textContent = "0";
  byId("thinking-empty").hidden = false; byId("thinking-empty").textContent = "Waiting for the model’s reasoning stream. Tool activity appears below.";
  for (const id of ["thinking", "coding"]) { byId(id).textContent = ""; }
  byId("thoughts").open = true; byId("thoughts").hidden = false; byId("code-preview").hidden = true;
}
let pendingAttachments = [];
let readingAttachments = false;
let sendingTask = false;
function renderAttachments() {
  const list = byId("attachments"); list.replaceChildren(); list.hidden = !pendingAttachments.length;
  for (const item of pendingAttachments) {
    const chip = document.createElement("div"), name = document.createElement("span"), remove = document.createElement("button");
    chip.className = "attachment-chip"; name.textContent = `${item.name} · ${Math.ceil(item.size / 1024)} KB`;
    remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", `Remove ${item.name}`);
    remove.onclick = () => { if (sendingTask || working) return; pendingAttachments = pendingAttachments.filter(value => value !== item); renderAttachments(); };
    chip.append(name, remove); list.append(chip);
  }
}
async function addAttachments(files) {
  if (native || working || repositoryBusy || sendingTask || readingAttachments) return;
  readingAttachments = true; byId("attach-files").disabled = true;
  try {
    const selected = [...files];
    if (pendingAttachments.length + selected.length > 4) throw Error("Attach up to four files per message.");
    let total = pendingAttachments.reduce((sum, item) => sum + item.size, 0); const additions = [];
    for (const file of selected) {
      total += file.size;
      if (!file.size || file.size > 2 * 1024 ** 2 || total > 4 * 1024 ** 2) throw Error("Attach nonempty files, up to 2 MB each and 4 MB total.");
      if (/\.(png|jpe?g|gif|webp|heic|bmp|mp3|mp4|wav|mov|ogg)$/i.test(file.name)) throw Error("Lite and Max read text. Images, audio and video are not supported.");
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      additions.push({name:file.name, size:file.size, data:btoa(binary)});
    }
    pendingAttachments.push(...additions); renderAttachments();
  } catch (error) { toast(error.message); }
  finally { readingAttachments = false; byId("attach-files").disabled = working || repositoryBusy; byId("attachment-files").value = ""; }
}
byId("attach-files").onclick = () => byId("attachment-files").click();
byId("attachment-files").onchange = event => void addAttachments(event.target.files);
byId("prompt").addEventListener("paste", event => { const files = event.clipboardData?.files; if (files?.length) { event.preventDefault(); void addAttachments(files); } });
byId("question").addEventListener("dragover", event => { event.preventDefault(); byId("question").classList.add("dragging"); });
byId("question").addEventListener("dragleave", () => byId("question").classList.remove("dragging"));
byId("question").addEventListener("drop", event => { event.preventDefault(); byId("question").classList.remove("dragging"); void addAttachments(event.dataTransfer?.files || []); });
async function task(text, retryAttachments) {
  if (text.trim() === "/skills") { openSettings("skills"); return; }
  if (text.trim() === "/mcp") { openSettings("mcp"); return; }
  if (["/clear","/new"].includes(text.trim())) { byId("new-session").click(); return; }
  if ((!text.trim() && !(retryAttachments || pendingAttachments).length) || working || repositoryBusy || native || sendingTask || readingAttachments) { return; }
  if (hasUnsavedFile()) { toast("Save or discard your file edits before starting a task."); return; }
  retryStart = false; lastTask = text; byId("error").hidden = true;
  const attachments = (retryAttachments || pendingAttachments).slice(); lastTaskAttachments = attachments; sendingTask = true;
  try {
    byId("send").disabled = true;
    await api("/api/task", { text: text.trim() ? text : "Read the attached files.", attachments: attachments.map(({name,data}) => ({name,data})) });
    if (byId("prompt").value === text) { byId("prompt").value = ""; byId("prompt").style.height = ""; }
    pendingAttachments = pendingAttachments.filter(item => !attachments.includes(item)); renderAttachments();
  } catch (error) { showError({message:error.message}); byId("send").disabled = false; }
  finally { sendingTask = false; }
}
byId("start").onclick = () => start();
byId("question").onsubmit = (event) => { event.preventDefault(); void task(byId("prompt").value); };

byId("cancel").onclick = () => { void (native ? native.invoke("cancel_start") : api("/api/cancel", {})).catch(() => {}); };
document.addEventListener("keydown", (event) => { if (working && !byId("settings-dialog").open && (event.key === "Escape" || event.ctrlKey && event.key.toLowerCase() === "c" && !window.getSelection()?.toString())) { event.preventDefault(); byId("cancel").click(); } });
byId("error-action").onclick = async () => {
  byId("error").hidden = true;
  if (errorAction === "OK") { if (!native) { await api("/api/dismiss", {}).catch(() => {}); } else { byId("welcome").hidden = false; } return; }
  if (errorAction === "Switch to a faster setting") { await start(true); return; }
  if (retryStart) { await start(); } else { await task(lastTask, lastTaskAttachments); }
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
    // The server holds this request until something changes, so an idle window sends nothing.
    const state = await api(`/api/state?after=${after}${stateKey ? `&wait=${encodeURIComponent(stateKey)}` : ""}`); stateKey = state.key || "";
    availableSkills = state.skills || []; for (const server of state.mcp || []) mcpNames.set(server.id, server.name);
    const activating = state.phase === "activate" || Boolean(state.activation?.required && !state.activation.active && ["choose", "error"].includes(state.phase));
    byId("activation").hidden = !activating;
    byId("welcome").hidden = activating || !(["choose", "error"].includes(state.phase) && !state.problem);
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
    byId("send").disabled = state.phase !== "ready" || state.repositoryBusy || sendingTask || readingAttachments;
    if (state.chatMemory) {
      byId("chat-memory-enabled").checked = state.chatMemory.enabled;
      byId("chat-memory-status").textContent = state.chatMemory.enabled ? `${state.chatMemory.turns} recent notes saved locally` : "Memory saving is off. Existing notes stay until you forget them.";
    } else { byId("chat-memory-status").textContent = "Chat memory is unavailable. Your current conversation still works."; }
    for (const id of ["chat-memory-enabled", "forget-chat-memory"]) byId(id).disabled = state.phase !== "ready" || state.repositoryBusy || !state.chatMemory;
    byId("attach-files").disabled = state.phase !== "ready" || state.repositoryBusy || sendingTask || readingAttachments;
    byId("session-model").textContent = (state.activeModel === "stellan-1-max" ? "Stellan-1 Max · code only" : state.paired ? "Stellan-1 Lite + Max · Lite runs tools, Max writes code" : "Stellan-1 Lite") + (state.longContext ? " · long context" : "");
    if (document.activeElement !== byId("long-context")) byId("long-context").checked = Boolean(state.longContext);
    if (document.activeElement !== byId("allow-internet")) byId("allow-internet").checked = state.internet !== false;
    // Stick AI needs very little space on the computer; below the comfortable amount it skips two speed caches.
    const disk = state.disk; const mb = (bytes) => `${Math.round(bytes / 1024 ** 2).toLocaleString()} MB`;
    byId("disk-warning").hidden = !disk || disk.free >= disk.comfortable;
    if (disk && disk.free < disk.minimum) byId("disk-warning").textContent = `This computer has only ${mb(disk.free)} free. Stick AI needs at least ${mb(disk.minimum)} free to start the model. Free up some space (empty the Bin or Trash, delete large downloads), then click Retry.`;
    else if (disk && disk.free < disk.comfortable) byId("disk-warning").textContent = `This computer has ${mb(disk.free)} free. Stick AI works, but new conversations start a little slower. With ${mb(disk.comfortable)} free it uses faster start-up caches.`;
    internetAllowed = state.internet !== false; maybeCheckUpdates();
    if (state.personal) savedPersonal = state.personal;
    if (!tourChecked && state.phase === "ready") { tourChecked = true; if (!state.onboarded && !byId("settings-dialog").open) openTour(); }
    const context = state.contextUsage;
    const knownUsage = context && Number.isSafeInteger(context.used) && context.used >= 0 && context.capacity > 0;
    const percentage = knownUsage ? Math.min(100, Math.round(context.used / context.capacity * 100)) : null;
    byId("context-fill").setAttribute("stroke-dasharray", `${percentage ?? 0} 100`);
    byId("context-percent").textContent = percentage === null ? "—" : `${percentage}%`;
    byId("context-wheel").setAttribute("aria-label", knownUsage ? `${context.used.toLocaleString()} of ${context.capacity.toLocaleString()} context tokens, last reported reply` : "Context token usage has not been reported");
    byId("context-used").textContent = knownUsage ? `${context.used.toLocaleString()} / ${context.capacity.toLocaleString()} · last reply` : "Usage not yet reported";
    byId("context-capacity").textContent = `${state.longContext ? "Long" : "Normal"} · ${(context?.capacity || 0).toLocaleString()} tokens`;
    byId("sidebar-memory-state").textContent = state.chatMemory?.enabled ? "on" : "off";
    byId("long-context").disabled = state.phase !== "ready" || state.repositoryBusy;
    if (state.contextTokens) byId("long-context-size").textContent = `Now: Lite sees up to ${state.contextTokens.lite.toLocaleString()} tokens, Max up to ${state.contextTokens.max.toLocaleString()}${state.longContext ? "" : " (long context mode raises this)"}.`;
    renderRepository(state.repository, state.repositoryBusy || state.phase === "working" || state.phase === "starting");
    byId("start").disabled = false;
    progress(state.progress, ["starting", "working"].includes(state.phase));
    const resting = state.resting && !["starting", "working"].includes(state.phase); byId("ready-dot").classList.toggle("resting", resting);
    if (resting) { byId("ready-label").textContent = "Resting"; byId("ready-label").title = "The model is paused to free memory. Your next message wakes it."; } else byId("ready-label").title = "";
    if (state.problem) { showError(state.problem); byId("ready-label").textContent = "Needs attention"; }
    for (const event of state.events) {
      after = event.id;
      if (event.kind === "user") { beginTurn(event.text); }
      if (event.kind === "attachments") {
        const documents = event.data.filter(file => file.kind !== "image"), images = event.data.filter(file => file.kind === "image");
        if (documents.length) message(`Attached: ${documents.map(file => file.name).join(", ")} · read locally as text`, "status");
        if (images.length) message(`Attached image${images.length === 1 ? "" : "s"}: ${images.map(file => file.label || file.name).join(", ")} · Stellan can add ${images.length === 1 ? "it" : "them"} to your project when you approve`, "status");
      }
      if (event.kind === "approval-resolved") { for (const card of byId("approvals").children) if (card.dataset.approval === event.data.id) card.remove(); }
      if (["answer", "thinking", "coding"].includes(event.kind)) { message(event.text, event.kind); }
      if (event.kind === "project") { projectEpoch++; expandedFolders.clear(); clearEditor(); filesLoaded = false; toolCards.clear(); byId("tool-activity").textContent = ""; byId("tool-count").textContent = "0"; byId("messages").textContent = ""; byId("approvals").textContent = ""; byId("thinking").textContent = ""; byId("coding").textContent = ""; streaming = undefined; lastTask = ""; lastTaskAttachments = []; pendingAttachments = []; renderAttachments(); if (event.text.startsWith("New conversation")) { byId("chat-empty").hidden = false; } else message(event.text, "status"); }
      if (event.kind === "skill") { toast("Skill loaded: " + event.data.names.join(", ")); }
      if (event.kind === "hook") { toast(event.data.blocked ? `A hook stopped this: ${event.data.blocked}` : event.data.problems.join(" ")); }
      if (event.kind === "tool") { renderTool(event.data); }
      if (event.kind === "task-complete") { byId("thinking-empty").textContent = byId("thinking").textContent ? "" : "This response did not emit separate reasoning. See the tool activity below."; void refreshFiles(); }
      if (event.kind === "file-saved") { void refreshFiles(); }
      if (event.kind === "status") { byId("status").textContent = event.text; }
      if (event.kind === "problem") { showError(event.data); }
      if (event.kind === "approval") {
        const card = approvalCard(event.data); const actions = document.createElement("div"); actions.className = "approval-actions"; card.append(actions);
        const web = event.data.kind === "web", search = web && event.data.title === "Search the web";
        const shell = event.data.kind === "shell";
        const image = event.data.kind === "image";
        for (const [label, allow] of [[shell ? "Don’t run" : image ? "Don’t add" : web ? (search ? "Don’t search" : "Don’t open") : event.data.kind === "mcp" ? "Deny call" : "Keep my file", false], [shell ? "Run it" : image ? "Add image" : web ? (search ? "Search" : "Read page") : event.data.kind === "mcp" ? "Allow tool call" : "Allow changes", true]]) {
          const button = document.createElement("button"); button.textContent = label; button.className = allow ? "primary" : "secondary";
          button.onclick = async () => { try { await api("/api/approve", { id: event.data.id, allow }); card.remove(); } catch { showError(); } }; actions.append(button);
        }
        byId("approvals").append(card); if (innerWidth <= 620) document.body.classList.remove("inspector-open"); scrollConversation(true);
      }
    }
    if (!["starting", "working"].includes(state.phase)) finishTurnActivity();
  } catch { stateKey = ""; if (!native) { showError({ message: "The assistant has stopped. Open the app again to continue.", action: "OK" }); } return false; }
  finally { polling = false; }
  return true;
}
function diffLines(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length * b.length > 250000) return [...a.map((text) => ["del", text]), ...b.map((text) => ["add", text])];
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const lines = []; let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push(["same", a[i]]); i++; j++; }
    else if (i < a.length && (j >= b.length || table[i + 1][j] >= table[i][j + 1])) lines.push(["del", a[i++]]);
    else lines.push(["add", b[j++]]);
  }
  return lines;
}
function approvalCard(data) {
  const card = document.createElement("article"), head = document.createElement("div"), text = document.createElement("div"), title = document.createElement("h3"), sub = document.createElement("span");
  card.className = "approval-card"; card.dataset.approval = data.id; head.className = "approval-head"; sub.className = "approval-sub";
  if (data.kind === "shell") {
    card.className = `approval-card${data.isolated ? "" : " unsandboxed"}`; title.textContent = "Run this command?"; sub.textContent = data.note;
    text.append(title, sub); head.append(icon("terminal"), text); card.append(head);
    const preview = document.createElement("pre"); preview.className = "command-preview"; preview.textContent = data.after; card.append(preview); return card;
  }
  if (data.kind === "image") {
    title.textContent = "Add this image to your project?"; sub.textContent = `${data.path}${data.replaces ? " · replaces the file that's there" : ""}`;
    text.append(title, sub); head.append(icon("file"), text); card.append(head);
    const details = document.createElement("p"); details.className = "approval-detail"; details.textContent = data.title; card.append(details);
    if (typeof data.preview === "string" && data.preview.startsWith("data:image/")) { const img = document.createElement("img"); img.className = "approval-image"; img.alt = `Preview of ${data.file}`; img.src = data.preview; card.append(img); }
    return card;
  }
  const web = data.kind === "web", mcp = data.kind === "mcp" || web; const editing = !mcp && Boolean(data.before);
  title.textContent = web ? (data.title === "Search the web" ? "Search the web for this?" : "Read this web page?") : mcp ? `Allow MCP call: ${data.title}?` : `Save changes to ${data.file}?`;
  const lines = (value) => value.split("\n").length;
  sub.textContent = web ? "Only this goes to Actuent. Your code stays on the stick." : mcp ? "Review the arguments this tool will receive" : `${data.path || data.file} · ${editing ? `replaces ${lines(data.before)} line${lines(data.before) === 1 ? "" : "s"} with ${lines(data.after)}` : `writes ${lines(data.after)} line${lines(data.after) === 1 ? "" : "s"}`}`;
  text.append(title, sub); head.append(icon(web ? "compass" : mcp ? "plug" : "shield"), text); card.append(head);
  if (editing) {
    const diff = document.createElement("div"); diff.className = "diff"; diff.setAttribute("role", "group"); diff.setAttribute("aria-label", "Proposed change");
    for (const [kind, line] of diffLines(data.before, data.after)) { const row = document.createElement("div"); row.className = `diff-line ${kind}`; row.dataset.sign = kind === "add" ? "+" : kind === "del" ? "−" : " "; row.textContent = line || " "; diff.append(row); }
    card.append(diff);
  } else { const preview = document.createElement("pre"); preview.textContent = data.after; card.append(preview); }
  return card;
}
// The desktop start page asks the native shell for progress; the workspace page long-polls its server.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async function loop() {
  for (;;) {
    if (native) { await pause(nativeStarting ? 150 : 500); await update(); continue; }
    if (!await update()) await pause(2000);
  }
})();

// Automatic update checks wait for the first state, so they respect "Allow internet".
function maybeCheckUpdates() {
  if (!autoCheckPending || internetAllowed === null) { return; }
  autoCheckPending = false;
  if (internetAllowed) { void checkAppUpdates(); }
  else { byId("update-message").textContent = "Allow internet is off, so the app doesn't check for updates by itself. You can still check here."; }
}
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
    // Copies updated from the private update host need no token; only older GitHub-based copies show this.
    if (result.state === "authentication") { byId("update-access").hidden = false; byId("update-access").open = true; }
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
    if (settings.enabled) { autoCheckPending = true; maybeCheckUpdates(); }
    else { byId("update-message").textContent = "Automatic checks are off. You can check for app updates here."; }
  }).catch(() => { byId("update-message").textContent = "Updates are unavailable. You can keep using the app offline."; });
}

// Model-free downloads link Lite (and optionally Max) from elsewhere on the stick.
let liteReady = true;
function showLocalModels(status) {
  byId("model-status").textContent = status.message; byId("max-quick-status").textContent = status.message;
  const lite = status.lite || { available: true };
  liteReady = lite.available;
  byId("quick-lite").hidden = liteReady; byId("start").disabled = nativeStarting || installingUpdate; byId("start").classList.toggle("needs-model", !liteReady);
  byId("unlink-lite").hidden = lite.source !== "linked";
  if (lite.path) { byId("lite-path").value = lite.path; }
  if (!liteReady) { byId("lite-selection").open = true; }
  const usable = status.available && status.eligible, slow = usable && status.slow;
  byId("assistant-mode").querySelector('[value="max"]').disabled = !usable;
  byId("assistant-mode").querySelector('[value="max"]').textContent = slow ? "Max directly (code only, very slow on this computer)" : "Max directly (code only)";
  byId("assistant-mode").querySelector('[value="auto"]').textContent = slow ? "Lite (recommended on this computer)" : usable ? "Lite + Max (recommended)" : "Lite (Max unavailable on this computer)";
  maxSlowMessage = slow ? status.slowMessage : ""; showMaxWarning();
  byId("unlink-max").hidden = status.source !== "linked";
  if (status.path) { byId("max-path").value = status.path; }
  if (!(status.available && status.eligible) && byId("assistant-mode").value === "max") { byId("assistant-mode").value = "auto"; }
}
let maxSlowMessage = "";
function showMaxWarning() { const box = byId("max-warning"); box.textContent = maxSlowMessage; box.hidden = !maxSlowMessage || byId("assistant-mode").value !== "max"; }
byId("assistant-mode").addEventListener("change", showMaxWarning);
async function setLocalModel(action, path, model = "max") {
  const ids = [`browse-${model}`, `link-${model}`, `unlink-${model}`];
  byId("start").disabled = true;
  for (const id of ids) { byId(id).disabled = true; }
  try { showLocalModels(await native.invoke(action, { ...(path === undefined ? {} : { path }), model })); }
  catch (error) { byId("model-status").textContent = typeof error === "string" ? error : `The ${model === "lite" ? "Lite" : "Max"} file could not be linked. Check the file and try again.`; }
  finally { byId("start").disabled = false; for (const id of ids) { byId(id).disabled = false; } }
}
const setLocalMax = (action, path) => setLocalModel(action, path, "max");
if (native) {
  byId("model-settings").hidden = false;
  native.invoke("local_model_status").then(showLocalModels).catch(() => { byId("model-status").textContent = "Max selection could not be read. Lite is still available."; });
  byId("link-max").onclick = () => setLocalMax("link_max_model", byId("max-path").value);
  byId("unlink-max").onclick = () => setLocalMax("unlink_max_model");
  byId("browse-max").onclick = async () => {
    try { const path = await native.invoke("choose_max_model"); if (path) { byId("max-path").value = path; await setLocalMax("link_max_model", path); } }
    catch (error) { byId("model-status").textContent = typeof error === "string" ? error : "Paste the full GGUF path, then choose Use this file."; }
  };
  byId("link-lite").onclick = () => setLocalModel("link_max_model", byId("lite-path").value, "lite");
  byId("unlink-lite").onclick = () => setLocalModel("unlink_max_model", undefined, "lite");
  const chooseLite = async () => {
    try { const path = await native.invoke("choose_max_model", { model: "lite" }); if (path) { byId("lite-path").value = path; await setLocalModel("link_max_model", path, "lite"); } }
    catch (error) { byId("model-status").textContent = typeof error === "string" ? error : "Paste the full GGUF path, then choose Use this file."; }
  };
  byId("browse-lite").onclick = chooseLite;
  byId("quick-lite").onclick = async () => { await chooseLite(); if (!liteReady) { openSettings("models"); byId("lite-selection").open = true; } };
}

let repositoryBusy = false;
let repositoryReview;
let lastRepository;
function renderRepository(workspace, busy) {
  lastRepository = workspace;
  for (const id of ["github-connect", "github-disconnect", "github-resume", "github-review", "github-publish"]) byId(id).disabled = busy || repositoryBusy;
  byId("github-review").disabled ||= !workspace;
  byId("github-status").textContent = workspace ? `${workspace.repository} · ${workspace.branch} · ${workspace.commit.slice(0,12)} · ${workspace.authenticated ? "signed in" : "public read access"}` : "Local project on this stick";
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
// ---------- Sign in with GitHub (device flow; the token never reaches this window) ----------
let signInTimer, signInView = { status: "signed-out" };
function renderSignIn(view) {
  signInView = view; const waiting = view.status === "waiting", signed = view.status === "signed-in";
  byId("github-signin-code").hidden = !waiting; if (waiting) byId("github-user-code").textContent = view.userCode;
  byId("github-signin").hidden = signed || waiting; byId("github-signout").hidden = !signed; byId("github-install").hidden = !signed;
  byId("github-signin-status").classList.toggle("ok", signed);
  byId("github-signin-status").textContent = signed ? `Signed in to GitHub${view.login ? ` as ${view.login}` : ""}. Stick AI can use the repositories you chose for it.` : view.message || "Sign in to work on private repositories and publish changes. Public repositories work without signing in.";
  clearTimeout(signInTimer); if (waiting) signInTimer = setTimeout(() => void refreshSignIn(), 2000);
}
async function refreshSignIn() { if (native) return; try { renderSignIn(await api("/api/github/signin")); } catch {} }
byId("github-signin").onclick = async () => {
  try { const view = await api("/api/github/signin/start", {}); renderSignIn(view); if (await copyText(view.userCode)) toast("Code copied. Paste it at github.com/login/device."); }
  catch (error) { byId("github-signin-status").textContent = error.message; }
};
byId("github-signin-cancel").onclick = async () => { try { renderSignIn(await api("/api/github/signin/cancel", {})); } catch {} };
byId("github-signout").onclick = async () => { try { renderSignIn(await api("/api/github/signout", {})); toast("Signed out of GitHub."); } catch {} };
byId("github-copy-code").onclick = async () => { if (await copyText(byId("github-user-code").textContent)) toast("Code copied."); };
byId("github-copy-link").onclick = async () => { if (await copyText(signInView.verificationUri || "https://github.com/login/device")) toast("Link copied. Paste it into your browser."); };
byId("github-install").onclick = async () => { if (await copyText(signInView.installUrl)) toast("Link copied. Paste it into your browser to choose which repositories Stick AI may use."); };
byId("github-panel").addEventListener("toggle", () => { if (byId("github-panel").open) void refreshSignIn(); });
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
  for (const name of ["models","you","github","mcp","skills","hooks","updates"]) byId(`settings-${name}`).hidden = name !== tab;
  if (tab === "you") showPersonal();
  byId("github-panel").open = true;
  if (["mcp","skills","hooks"].includes(tab) && !native) void refreshExtensions();
  if (tab === "github" && !native) void refreshSignIn();
  if (!byId("settings-dialog").open) byId("settings-dialog").showModal();
}
// "About you": filled from the saved settings each time the tab opens, saved only when the user presses Save.
let savedPersonal = null;
function showPersonal() {
  byId("personal-native").hidden = !native; byId("personal-fields").hidden = Boolean(native);
  if (native || !savedPersonal) return;
  byId("personal-name").value = savedPersonal.name || ""; byId("personal-about").value = savedPersonal.about || "";
  byId("personal-style").value = savedPersonal.style || "balanced"; byId("personal-preferences").value = savedPersonal.preferences || "";
  byId("personal-message").textContent = "";
}
byId("personal-save").onclick = async () => {
  byId("personal-save").disabled = true;
  try {
    const result = await api("/api/personal", { name: byId("personal-name").value, about: byId("personal-about").value, style: byId("personal-style").value, preferences: byId("personal-preferences").value });
    savedPersonal = result.personal; byId("personal-message").textContent = "Saved. Stellan will use this from your next message.";
  } catch (error) { byId("personal-message").textContent = error.message || "Couldn't save. Try again."; }
  finally { byId("personal-save").disabled = false; }
};
byId("open-settings").onclick = () => openSettings("models");
byId("open-github").onclick = () => openSettings("github");
byId("open-updates").onclick = () => openSettings("updates");
byId("quick-max").onclick = () => { openSettings("models"); byId("max-selection").open = true; };
byId("close-settings").onclick = () => byId("settings-dialog").close();
for (const button of document.querySelectorAll("[data-settings]")) button.onclick = () => openSettings(button.dataset.settings);
function applyTheme(light) { document.documentElement.classList.toggle("light", light); byId("theme-label").textContent = light ? "Dark appearance" : "Light appearance"; }
byId("theme-toggle").onclick = () => { const light = !document.documentElement.classList.contains("light"); applyTheme(light); try { localStorage.setItem("stick-theme", light ? "light" : "dark"); } catch {} };
{ let saved = null; try { saved = localStorage.getItem("stick-theme"); } catch {} const system = matchMedia("(prefers-color-scheme: light)"); applyTheme(saved ? saved === "light" : system.matches); system.addEventListener?.("change", (event) => { let chosen = null; try { chosen = localStorage.getItem("stick-theme"); } catch {} if (!chosen) applyTheme(event.matches); }); }
byId("sidebar-toggle").onclick = () => { if (innerWidth <= 860) document.body.classList.toggle("sidebar-open"); else document.body.classList.toggle("sidebar-hidden"); };
byId("activity-toggle").onclick = () => { if (innerWidth <= 620) document.body.classList.toggle("inspector-open"); else document.body.classList.toggle("inspector-hidden"); };
function inspectorTab(file) { byId("activity-panel").hidden = file; byId("file-panel").hidden = !file; byId("tab-file").classList.toggle("active", file); byId("tab-activity").classList.toggle("active", !file); document.body.classList.remove("inspector-hidden"); if (innerWidth <= 620) document.body.classList.add("inspector-open"); }
byId("tab-file").onclick = () => inspectorTab(true); byId("tab-activity").onclick = () => inspectorTab(false);
const toolTitle = (tool) => ({read_file:"Read file",list_dir:"Explore files",search_files:"Search project",write_file:"Write file",edit_file:"Edit file",delegate_code:"Hand off to Max",run_shell:"Run command",mcp_tools:"Discover MCP tools",mcp_call:"Call MCP tool",use_skill:"Read skill",web_search:"Search the web",read_web_page:"Read web page",save_image:"Add image"})[tool] || tool;
const toolIcon = (tool) => ({read_file:"file",list_dir:"folder",search_files:"search",write_file:"pencil",edit_file:"pencil",delegate_code:"arrow-right",run_shell:"terminal",mcp_tools:"plug",mcp_call:"plug",use_skill:"book",web_search:"compass",read_web_page:"compass",save_image:"file"})[tool] || "sparkle";
function renderTool(data) {
  turnStep(data, toolTitle(data.tool), toolIcon(data.tool));
  let card = toolCards.get(data.step);
  if (!card) {
    if (!toolCards.size) byId("tool-activity").textContent = "";
    card = document.createElement("div"); card.className = "tool-card"; thinkingBreak = true;
    const badge = document.createElement("span"); badge.className = "tool-icon"; badge.append(icon(toolIcon(data.tool))); card.append(badge);
    const title = document.createElement("strong"); title.textContent = toolTitle(data.tool);
    const path = document.createElement("span"); path.className = "tool-path"; path.textContent = [".", "./", ""].includes(data.path ?? "") ? data.detail || "Project root" : data.path; for (const [id,name] of mcpNames) path.textContent = path.textContent.replace(id,name);
    card.append(title,path); byId("tool-activity").append(card); toolCards.set(data.step,card); byId("tool-count").textContent = String(toolCards.size);
  }
  if (data.phase === "finish") {
    const failed = data.result?.startsWith("Error:") || data.result === "Denied by user";
    card.classList.add(failed ? "failed" : "complete"); card.querySelector(".tool-icon")?.replaceChildren(icon(failed ? "x" : "check"));
    const details = document.createElement("details"), summary = document.createElement("summary"), content = document.createElement("pre"); summary.textContent = "Result"; content.textContent = data.result || "Finished"; details.append(summary,content); card.append(details);
    if (["write_file","edit_file"].includes(data.tool)) { void refreshFiles(); void reloadCurrentFile(data.path); }
  }
}
async function fileEntries(parent,path) {
  const result = await api(`/api/files?path=${encodeURIComponent(path || ".")}`);
  for (const entry of result.entries) {
    const relative = path ? `${path}/${entry.name}` : entry.name;
    const button = document.createElement("button"), glyph = document.createElement("span"), name = document.createElement("span"); button.className = `file-entry${entry.directory ? " is-dir" : ""}${relative === currentFile ? " active" : ""}`; button.title = relative; button.dataset.path = relative; glyph.className = "file-icon"; glyph.append(icon(entry.directory ? "folder" : "file")); name.textContent = entry.name;
    const chevron = icon("chevron"); chevron.classList.add("chev"); if (!entry.directory) chevron.classList.add("blank");
    button.append(chevron,glyph,name); parent.append(button);
    if (entry.directory) {
      button.setAttribute("aria-expanded", "false");
      const children = document.createElement("div"); children.className = "file-children"; children.hidden = true; parent.append(children);
      const expand = async () => { if (children.hidden) { children.textContent = ""; await fileEntries(children,relative); children.hidden = false; expandedFolders.add(relative); button.classList.add("open"); button.setAttribute("aria-expanded", "true"); } else { children.hidden = true; expandedFolders.delete(relative); button.classList.remove("open"); button.setAttribute("aria-expanded", "false"); } };
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
  try { const result = await api(`/api/file?path=${encodeURIComponent(path)}`); if (requestId !== fileRequest || epoch !== projectEpoch) return; if (hasUnsavedFile()) { toast("Your unsaved edits were kept. Save or discard them before switching files."); return; } currentFile = result.path; originalFile = result.content; byId("file-title").textContent = path; byId("file-title").title = path; byId("file-editor").value = result.content; byId("file-editor").disabled = false; byId("file-editor").readOnly = working; byId("file-status").textContent = "Saved on this stick"; updateEditorState(); for (const entry of document.querySelectorAll(".file-entry")) entry.classList.toggle("active", entry.dataset.path === currentFile); inspectorTab(true); document.body.classList.remove("sidebar-open"); }
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
  try { await api("/api/session/reset",{}); pendingAttachments = []; renderAttachments(); byId("messages").textContent = ""; byId("chat-empty").hidden = false; byId("thinking").textContent = ""; byId("coding").textContent = ""; byId("thinking-empty").hidden = false; byId("thinking-empty").textContent = "Model reasoning will stream here. Some responses do not emit separate reasoning."; byId("prompt").focus(); } catch (error) { toast(error.message); }
};
byId("local-project").onclick = () => { if (native) return; if (lastRepository) byId("github-disconnect").click(); else void refreshFiles(); };
byId("prompt").addEventListener("keydown", event => { if (!byId("skill-menu").hidden && ["ArrowDown","ArrowUp","Enter","Escape"].includes(event.key)) { event.preventDefault(); if (event.key === "Escape") byId("skill-menu").hidden = true; else if (event.key === "Enter") chooseSkillMenu(); else { skillMenuIndex += event.key === "ArrowDown" ? 1 : -1; highlightSkillMenu(); } return; } if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!byId("send").disabled) byId("question").requestSubmit(); } });
byId("prompt").addEventListener("input", () => { renderSkillMenu(); byId("prompt").style.height = "auto"; byId("prompt").style.height = Math.min(230,byId("prompt").scrollHeight) + "px"; });
document.addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); byId("new-session").click(); } });
for (const button of document.querySelectorAll("[data-prompt]")) button.onclick = () => { byId("prompt").value = button.dataset.prompt; byId("prompt").dispatchEvent(new Event("input")); byId("prompt").focus(); };
if (native) {
  byId("new-session").disabled = true;
  for (const id of ["github-connect","github-resume","github-review","github-disconnect","github-refresh","github-publish"]) byId(id).disabled = true;
  byId("github-result").textContent = "Open the workspace first, then connect your repository here.";
} else { byId("quick-max").hidden = true; byId("running-model-note").hidden = false; byId("running-update-note").hidden = false; byId("long-context-panel").hidden = false; byId("show-tour").hidden = false; }

const shortcutHint = document.querySelector("#new-session kbd"); if (shortcutHint) shortcutHint.textContent = /Mac/.test(navigator.platform) ? "⌘ N" : "Ctrl N";

window.addEventListener("beforeunload", event => { if (hasUnsavedFile()) { event.preventDefault(); event.returnValue = ""; } });
document.addEventListener("click", event => { if (document.body.classList.contains("sidebar-open") && !event.target.closest(".sidebar") && !event.target.closest("#sidebar-toggle")) document.body.classList.remove("sidebar-open"); });

let availableSkills = [];
const mcpNames = new Map();
let extensionBusy = false;
let skillPreview;
let skillMenuIndex = 0;
let skillMenuItems = [];
byId("open-mcp").onclick = () => openSettings("mcp");
byId("open-skills").onclick = () => openSettings("skills");
function jsonField(id, fallback) { const text = byId(id).value.trim(); try { return text ? JSON.parse(text) : fallback; } catch { throw new Error("Enter valid JSON for arguments, headers and environment fields."); } }
function credentialFields(bearer,headers,env) { let h = headers.value.trim() ? JSON.parse(headers.value) : undefined; const token = bearer.value.trim(); if (token) h = {...(h||{}),Authorization:`Bearer ${token}`}; return {...(h ? {headers:h}:{}),...(env.value.trim()?{env:JSON.parse(env.value)}:{})}; }
async function extensionAction(path,data,message) {
  if (native) { byId(message).textContent = "Open the workspace first to manage MCP servers, skills and hooks."; return; }
  extensionBusy = true; byId(message).textContent = "Working…"; byId("mcp-cancel").hidden = false;
  try { return await api(path,data); } catch(error) { byId(message).textContent = error.message; throw error; }
  finally { extensionBusy = false; byId("mcp-cancel").hidden = true; }
}
function element(tag,text,className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
function actionButton(text,handler) { const button = element("button",text,"secondary"); button.type = "button"; button.onclick = handler; return button; }
async function refreshExtensions() {
  if (native) return;
  try {
    const data = await api("/api/extensions"); byId("mcp-server-list").textContent = ""; byId("skills-list").textContent = ""; renderHooks(data.hooks || []);
    const web = element("article",undefined,"extension-card builtin-card");web.append(element("h4","Web search · Actuent"),element("p",data.webSearch?"on · built in · free":"off","extension-status"),element("p",data.webSearch?"Lite can look things up on the live web: docs, versions, error messages, prices and news. Each search shows you the exact words first; only those go online.":"Lite stays fully offline. Turn this on to let it look things up on the web, with your approval each time."));
    const webToggle = actionButton(data.webSearch?"Turn off web search":"Turn on web search",async()=>{try{await extensionAction("/api/mcp/web-search",{enabled:!data.webSearch},"mcp-message");byId("mcp-message").textContent=data.webSearch?"Web search is off.":"Web search is on. Searches still ask you first.";await refreshExtensions();}catch{}});webToggle.disabled=extensionBusy;web.append(webToggle);byId("mcp-server-list").append(web);
    if (!data.servers.some(s=>!s.builtin)) byId("mcp-server-list").append(element("p","No other servers yet. Add a URL or local program below."));
    for (const server of data.servers) {
      if (server.builtin) { mcpNames.set(server.id,server.name); continue; }
      mcpNames.set(server.id,server.name);const card = element("article",undefined,"extension-card");card.append(element("h4",server.name),element("p",`${server.transport} · ${server.status} · ${server.tools} tools`,"extension-status"),element("pre",server.url || [server.command,...server.args].join(" ")));
      const access = element("details"),summary = element("summary","Session access"),bearer = element("input"),headers = element("input"),env = element("input");
      for (const input of [bearer,headers,env]) {input.type="password";input.autocomplete="off";}bearer.placeholder="Bearer token";headers.placeholder='Secret headers JSON';env.placeholder='Environment JSON';access.append(summary,bearer,headers,env);card.append(access);
      const connect = actionButton(server.status === "connected" ? "Disconnect" : "Connect",async()=>{try {const fields=credentialFields(bearer,headers,env);await extensionAction(server.status === "connected"?"/api/mcp/disconnect":"/api/mcp/connect",{id:server.id,...fields},"mcp-message");for(const input of [bearer,headers,env])input.value="";byId("mcp-message").textContent=server.status === "connected"?"Server disconnected.":"Server connected. Lite can discover its tools.";await refreshExtensions();}catch(error){byId("mcp-message").textContent=error.message;}});
      const remove = actionButton("Remove",async()=>{try{await extensionAction("/api/mcp/remove",{id:server.id},"mcp-message");await refreshExtensions();byId("mcp-message").textContent="Server removed.";}catch{}});connect.disabled=extensionBusy;remove.disabled=extensionBusy;card.append(connect,remove);if(server.error)card.append(element("p",server.error));if(server.diagnostic){const details=element("details");details.append(element("summary","Server diagnostics"),element("pre",server.diagnostic));card.append(details);}byId("mcp-server-list").append(card);
    }
    for (const skill of data.skills) {
      const card=element("article",undefined,"extension-card");card.append(element("h4",`/${skill.name}`),element("p",skill.description),element("p",`${skill.source} · ${skill.changed?"changed—review again":skill.enabled?"enabled":"disabled"}`,"extension-status"));
      card.append(actionButton("Review",async()=>{try {skillPreview=await api(`/api/skills/preview?id=${encodeURIComponent(skill.id)}`);byId("skill-preview-title").textContent=`/${skillPreview.name} · ${skillPreview.source}`;byId("skill-preview-text").textContent=skillPreview.instructions;byId("skill-enable").textContent=skillPreview.enabled?"Disable skill":"Enable reviewed skill";byId("skill-use").disabled=!skillPreview.enabled||!skillPreview.userInvocable;byId("skill-preview").hidden=false;byId("skill-preview").scrollIntoView({block:"nearest"});}catch(error){byId("skills-message").textContent=error.message;}}));byId("skills-list").append(card);
    }
    if(data.problem)byId("mcp-message").textContent=data.problem;
  }catch(error){byId("mcp-message").textContent=error.message;}
}
// ---------- Hooks ----------
const hookLabels = { SessionStart: "When a conversation starts", UserPromptSubmit: "When you send a message", PreToolUse: "Before Stellan uses a tool", PostToolUse: "After Stellan uses a tool", Notification: "When Stellan needs your approval", Stop: "When Stellan finishes" };
function renderHooks(hooks) {
  const list = byId("hooks-list"); list.textContent = "";
  if (!hooks.length) list.append(element("p", "No hooks yet. Add one below, for example to hear a sound when Stellan finishes."));
  for (const hook of hooks) {
    const card = element("article", undefined, "extension-card");
    const what = hook.type === "http" ? `notifies ${new URL(hook.url).host}` : "runs a command";
    card.append(element("h4", hook.name), element("p", `${hookLabels[hook.event] || hook.event}${hook.matcher ? ` · ${hook.matcher}` : ""} · ${what} · ${hook.enabled ? "on" : "off"}`, "extension-status"), element("pre", hook.type === "http" ? hook.url : hook.command));
    const test = actionButton("Test", async () => { try { const result = await extensionAction("/api/hooks/test", { id: hook.id }, "hooks-message"); byId("hooks-message").textContent = result.problems.length ? result.problems.join(" ") : result.blocked ? `It works, and it would block: ${result.blocked}` : result.context ? `It works. It replied: ${result.context.slice(0, 300)}` : "It works."; } catch {} });
    const toggle = actionButton(hook.enabled ? "Turn off" : "Turn on", async () => { try { await extensionAction("/api/hooks/enable", { id: hook.id, enabled: !hook.enabled }, "hooks-message"); await refreshExtensions(); byId("hooks-message").textContent = hook.enabled ? "Hook turned off." : "Hook turned on."; } catch {} });
    const remove = actionButton("Remove", async () => { try { await extensionAction("/api/hooks/remove", { id: hook.id }, "hooks-message"); await refreshExtensions(); byId("hooks-message").textContent = "Hook removed."; } catch {} });
    for (const button of [test, toggle, remove]) button.disabled = extensionBusy;
    const row = element("div", undefined, "button-row"); row.append(test, toggle, remove); card.append(row); list.append(card);
  }
}
function hookFormFields() {
  const event = byId("hook-event").value, http = byId("hook-type").value === "http";
  byId("hook-matcher-field").hidden = !["PreToolUse", "PostToolUse"].includes(event); byId("hook-command-field").hidden = http; byId("hook-url-field").hidden = !http;
}
byId("hook-event").onchange = hookFormFields; byId("hook-type").onchange = hookFormFields;
byId("hook-add").onclick = async () => {
  const event = byId("hook-event").value, type = byId("hook-type").value;
  const data = { name: byId("hook-name").value, event, type, timeout: byId("hook-timeout").value, matcher: ["PreToolUse", "PostToolUse"].includes(event) ? byId("hook-matcher").value : "", ...(type === "http" ? { url: byId("hook-url").value } : { command: byId("hook-command").value }) };
  try { await extensionAction("/api/hooks/add", data, "hooks-message"); for (const id of ["hook-name", "hook-matcher", "hook-command", "hook-url"]) byId(id).value = ""; byId("hook-form").open = false; await refreshExtensions(); byId("hooks-message").textContent = "Hook added. Use Test to try it."; } catch {}
};
byId("open-hooks").onclick = () => openSettings("hooks");
// ---------- One-time activation ----------
byId("activation-code").addEventListener("input", (event) => {
  const raw = event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 12);
  event.target.value = raw.match(/.{1,4}/g)?.join("-") ?? "";
});
byId("activation-form").onsubmit = async (event) => {
  event.preventDefault(); const message = byId("activation-message");
  byId("activate").disabled = true; message.classList.remove("error"); message.textContent = "Activating…";
  try { await api("/api/activate", { code: byId("activation-code").value }); message.textContent = "Activated. Starting Stellan…"; toast("Your stick is activated. Welcome!"); }
  catch (error) { message.classList.add("error"); message.textContent = error.message; }
  finally { byId("activate").disabled = false; }
};
// ---------- Welcome tour (once, remembered on the stick; reopen from Settings) ----------
let tourStep = 1, tourChecked = false;
function showTourStep(step) {
  tourStep = step;
  for (const section of document.querySelectorAll(".tour-step")) section.hidden = Number(section.dataset.step) !== step;
  document.querySelectorAll(".tour-dots span").forEach((dot, index) => dot.classList.toggle("on", index === step - 1));
  byId("tour-count").textContent = `${step} of 4`; byId("tour-back").hidden = step === 1;
  byId("tour-next").textContent = step === 4 ? "Start using Stick AI" : "Next";
}
function openTour() { showTourStep(1); if (!byId("tour-dialog").open) byId("tour-dialog").showModal(); }
async function finishTour() { byId("tour-dialog").close(); try { await api("/api/onboarded", {}); } catch {} byId("prompt").focus(); }
byId("tour-next").onclick = () => { if (tourStep < 4) showTourStep(tourStep + 1); else void finishTour(); };
byId("tour-back").onclick = () => showTourStep(Math.max(1, tourStep - 1));
byId("tour-skip").onclick = () => void finishTour();
byId("tour-dialog").addEventListener("cancel", () => { void api("/api/onboarded", {}).catch(() => {}); });
byId("show-tour").onclick = () => { byId("settings-dialog").close(); openTour(); };
byId("allow-internet").onchange = async () => {
  const enabled = byId("allow-internet").checked;
  try { await api("/api/internet", { enabled }); toast(enabled ? "Internet extras are on: web search, GitHub and online MCP servers." : "Allow internet is off. Nothing leaves this computer."); }
  catch (error) { byId("allow-internet").checked = !enabled; toast(error.message); }
};
byId("long-context").onchange = async () => {
  const enabled = byId("long-context").checked;
  try { await api("/api/long-context", { enabled }); toast(enabled ? "Long context mode is on. Restarting the model…" : "Long context mode is off. Restarting the model…"); }
  catch (error) { byId("long-context").checked = !enabled; toast(error.message); }
};
byId("mcp-refresh").onclick = refreshExtensions;byId("skills-refresh").onclick=refreshExtensions;
byId("mcp-cancel").onclick=()=>api("/api/cancel",{}).catch(()=>{});
byId("mcp-transport").onchange=()=>{const local=byId("mcp-transport").value==="stdio";byId("mcp-local-fields").hidden=!local;byId("mcp-remote-fields").hidden=local;};
async function addMcp(connect) {
  if(extensionBusy)return;
  try {
    const fields=credentialFields(byId("mcp-bearer"),byId("mcp-headers"),byId("mcp-env"));const result=await extensionAction("/api/mcp/add",{name:byId("mcp-name").value,transport:byId("mcp-transport").value,url:byId("mcp-url").value,command:byId("mcp-command").value,args:jsonField("mcp-args",[]),...fields},"mcp-message");if(!result)return;
    for(const id of ["mcp-bearer","mcp-headers","mcp-env"])byId(id).value="";
    if(connect)await extensionAction("/api/mcp/connect",{id:result.id},"mcp-message");byId("mcp-message").textContent=connect?"Connected. MCP calls appear in live activity and require your approval.":"Server saved. Connect it when you are ready.";await refreshExtensions();
  }catch(error){byId("mcp-message").textContent=error.message;await refreshExtensions();}
}
byId("mcp-add").onclick=()=>addMcp(true);byId("mcp-save").onclick=()=>addMcp(false);
byId("mcp-import-project").onclick=async()=>{try{await extensionAction("/api/mcp/import",{},"mcp-message");byId("mcp-message").textContent="Project servers imported. Review and connect them individually.";await refreshExtensions();}catch{}};
byId("mcp-import-json").onclick=async()=>{try{await extensionAction("/api/mcp/import",{text:byId("mcp-config-json").value},"mcp-message");byId("mcp-config-json").value="";byId("mcp-message").textContent="Servers imported and left disconnected.";await refreshExtensions();}catch{}};
byId("skill-enable").onclick=async()=>{if(!skillPreview)return;try{await extensionAction("/api/skills/enable",{id:skillPreview.id,digest:skillPreview.digest,enabled:!skillPreview.enabled},"skills-message");byId("skill-preview").hidden=true;byId("skills-message").textContent="Skill preference saved.";await refreshExtensions();}catch{}};
byId("skill-use").onclick=()=>{if(!skillPreview)return;byId("prompt").value=`/${skillPreview.name} `;byId("settings-dialog").close();byId("prompt").focus();};
byId("skill-copy").onclick=()=>{if(!skillPreview)return;byId("skill-name").value=skillPreview.name;byId("skill-description").value=skillPreview.description;byId("skill-instructions").value=skillPreview.instructions;byId("skill-model-invocable").checked=skillPreview.modelInvocable;byId("skill-user-invocable").checked=skillPreview.userInvocable;byId("skill-instructions").closest("details").open=true;byId("skill-instructions").focus();};
byId("skill-save").onclick=async()=>{try{await extensionAction("/api/skills/save",{name:byId("skill-name").value,description:byId("skill-description").value,instructions:byId("skill-instructions").value,modelInvocable:byId("skill-model-invocable").checked,userInvocable:byId("skill-user-invocable").checked},"skills-message");byId("skills-message").textContent="Skill saved and enabled. Use its /command in a message.";await refreshExtensions();}catch{}};
byId("skill-import-file").onchange=async()=>{const file=byId("skill-import-file").files?.[0];if(!file)return;try{if(file.size>65536)throw new Error("SKILL.md must be under 64 KiB.");const result=await extensionAction("/api/skills/import",{text:await file.text()},"skills-message");if(!result)return;byId("skill-name").value=result.name;byId("skill-description").value=result.description;byId("skill-instructions").value=result.body;byId("skill-model-invocable").checked=result.modelInvocable;byId("skill-user-invocable").checked=result.userInvocable;byId("skills-message").textContent="Imported into the editor. Review it, then Save & enable.";}catch(error){byId("skills-message").textContent=error.message;}finally{byId("skill-import-file").value="";}};
function renderSkillMenu(force=false) {
 const value=byId("prompt").value;const query=value.startsWith("/")&&!/\s/.test(value)?value.slice(1).toLowerCase():force?"":null;byId("skill-menu").hidden=query===null;if(query===null)return;
 const commands=[{name:"skills",description:"Manage your skill packs"},{name:"mcp",description:"Connect MCP tool servers"},{name:"clear",description:"Start a new conversation"},...availableSkills];const seen=new Set();skillMenuItems=commands.filter(s=>!seen.has(s.name)&&seen.add(s.name)&&s.name.includes(query)).slice(0,8);skillMenuIndex=0;byId("skill-menu").textContent="";
 for(const [index,skill]of skillMenuItems.entries()){const button=element("button");button.type="button";button.setAttribute("role","option");button.append(element("strong","/"+skill.name),element("span",skill.description));button.onclick=()=>{skillMenuIndex=index;chooseSkillMenu();};byId("skill-menu").append(button);}if(!skillMenuItems.length)byId("skill-menu").append(element("p","No enabled skills match."));highlightSkillMenu();
}
function highlightSkillMenu(){if(!skillMenuItems.length)return;skillMenuIndex=(skillMenuIndex+skillMenuItems.length)%skillMenuItems.length;for(const [index,button]of [...byId("skill-menu").children].entries())button.classList.toggle("active",index===skillMenuIndex);}
function chooseSkillMenu(){const selected=skillMenuItems[skillMenuIndex];if(!selected)return;byId("prompt").value=`/${selected.name} `;byId("skill-menu").hidden=true;byId("prompt").focus();}
byId("skill-picker").onclick=()=>renderSkillMenu(true);
if(native){byId("mcp-message").textContent="Open the workspace first to configure tool servers.";byId("skills-message").textContent="Open the workspace to browse, create and enable skills.";for(const id of ["mcp-add","mcp-save","mcp-import-project","mcp-import-json","mcp-refresh","skills-refresh","skill-save","skill-import-file"])byId(id).disabled=true;}

byId("chat-memory-enabled").onchange = async event => { try { await api("/api/chat-memory", { enabled:event.target.checked }); } catch (error) { toast(error.message); } };
byId("view-chat-memory").onclick = async () => { try { const data=await api("/api/chat-memory"); byId("chat-memory-preview").textContent=data.notes; byId("chat-memory-preview").hidden=false; } catch (error) { toast(error.message); } };
byId("forget-chat-memory").onclick = async () => { try { await api("/api/chat-memory", {forget:true}); byId("chat-memory-preview").textContent="Saved notes for this chat were removed. The open conversation is kept."; byId("chat-memory-preview").hidden=false; } catch (error) { toast(error.message); } };
