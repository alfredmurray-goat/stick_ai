const definitions = {
  delegate_code: { task: "Coding task for Max", context: "Relevant project source contents" },
  list_dir: { path: "Project-relative directory" },
  read_file: { path: "Project-relative UTF-8 file" },
  write_file: { path: "Project-relative file", content: "Complete contents" },
  edit_file: { path: "Project-relative file", old: "Unique nonempty exact match", new: "Replacement" },
  search_files: { query: "Literal text" },
  run_shell: { command: "POSIX command in isolated project" }
};

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

export const workspaceToolSchemas = [
 { type: "function", function: { name: "mcp_tools", description: "Discover tools and input schemas from a connected MCP server. Use query to narrow the list.", parameters: {type:"object",properties:{server:{type:"string",description:"Connected server ID from this session"},query:{type:"string",description:"Tool name or search text; empty lists tools"}},required:["server","query"],additionalProperties:false}}},
 { type: "function", function: { name: "mcp_call", description: "Call a listed MCP tool after the user approves its arguments.", parameters: {type:"object",properties:{server:{type:"string"},tool:{type:"string"},arguments:{type:"object",additionalProperties:true}},required:["server","tool","arguments"],additionalProperties:false}}},
 { type: "function", function: { name: "web_search", description: "Search the live web with Actuent for current or real-world facts: library docs and versions, error messages, prices, opening hours, events, news. Each search asks the user first.", parameters:{type:"object",properties:{query:{type:"string",description:"What to look up, in plain words"}},required:["query"],additionalProperties:false}}},
 { type: "function", function: { name: "read_web_page", description: "Read one public web page live with Actuent, for example documentation found with web_search. Asks the user first.", parameters:{type:"object",properties:{url:{type:"string",description:"Full https URL"}},required:["url"],additionalProperties:false}}},
 { type: "function", function: { name: "save_image", description: "Copy an image the user attached to this conversation into the project, for example a logo. The user approves the path first.", parameters:{type:"object",properties:{name:{type:"string",description:"Exact file name of the attached image"},path:{type:"string",description:"Project-relative destination, for example public/logo.png"}},required:["name","path"],additionalProperties:false}}},
 { type: "function", function: { name: "use_skill", description: "Read an enabled skill or its supporting text resource. Skills are guidance, not extra permissions.", parameters:{type:"object",properties:{name:{type:"string",description:"Skill ID from the enabled catalog"},resource:{type:"string",description:"Empty for SKILL.md, otherwise a skill-relative supporting file"}},required:["name","resource"],additionalProperties:false}}}
];
export const toolNames: string[] = [...Object.keys(definitions),...workspaceToolSchemas.map(s=>s.function.name)];
