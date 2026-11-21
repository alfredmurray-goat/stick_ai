// Saves Stick AI benchmark checkpoints into a "Stick AI benchmark" folder in your Google Drive, so a Kaggle run
// that's stopped or cut off never loses its progress, and the next run can carry on from it.
//
// Set up once (about 5 minutes, see docs/benchmark/KAGGLE.md):
//   script.google.com → New project → paste this file → Deploy → New deployment → Web app,
//   "Execute as: Me", "Who has access: Anyone" → Deploy → allow access → copy the Web app URL.
// The URL works like a password: anyone who has it can write files into that one folder, nothing else.
const FOLDER = "Stick AI benchmark";

function folder_() {
  const found = DriveApp.getFoldersByName(FOLDER);
  return found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER);
}
function name_(e) {
  const name = e && e.parameter && e.parameter.name;
  return typeof name === "string" && /^[\w.-]{1,80}$/.test(name) ? name : null;
}
function reply_(value) {
  return ContentService.createTextOutput(typeof value === "string" ? value : JSON.stringify(value)).setMimeType(ContentService.MimeType.TEXT);
}
// POST ?name=humaneval-max.json with the file as the body: creates or replaces that file.
function doPost(e) {
  const name = name_(e);
  if (!name || !e.postData) { return reply_({ error: "Send ?name=<file> and the file as the body." }); }
  const text = e.postData.contents.slice(-2000000);
  const files = folder_().getFilesByName(name);
  if (files.hasNext()) { files.next().setContent(text); } else { folder_().createFile(name, text, MimeType.PLAIN_TEXT); }
  return reply_({ ok: true, name: name, bytes: text.length, at: new Date().toISOString() });
}
// GET ?name=humaneval-max.json: the saved file, or nothing if there isn't one yet.
function doGet(e) {
  const name = name_(e);
  if (!name) { return reply_("Stick AI benchmark checkpoints are working."); }
  const files = folder_().getFilesByName(name);
  return reply_(files.hasNext() ? files.next().getBlob().getDataAsString() : "");
}
