const definitions = {
  delegate_code: { task: "Coding task for Max", context: "Relevant project source contents" },
  list_dir: { path: "Project-relative directory" },
  read_file: { path: "Project-relative UTF-8 file" },
  write_file: { path: "Project-relative file", content: "Complete contents" },
  edit_file: { path: "Project-relative file", old: "Unique nonempty exact match", new: "Replacement" },
  search_files: { query: "Literal text" },
  run_shell: { command: "POSIX command in isolated project" }
};
export const toolNames: string[] = Object.keys(definitions);
export const toolSchemas = Object.entries(definitions).map(([name, fields]) => ({
  type: "function",
  function: {
    name,
    description: name.replaceAll("_", " "),
    parameters: {
      type: "object",
      properties: Object.fromEntries(Object.entries(fields).map(([key, description]) => [key, { type: "string", description }])),
      required: Object.keys(fields),
      additionalProperties: false
    }
  }
}));
