import { toolNames } from "../tools/schema.js";

export const stellanGrammar = String.raw`root ::= ws (thinking ws)? (tool-call | done) ws
thinking ::= "<think>" thought-char* "</think>"
thought-char ::= [^<] | "<" [^/] | "</" [^t] | "</t" [^h] | "</th" [^i] | "</thi" [^n] | "</thin" [^k] | "</think" [^>]
done ::= "<done>" done-char+ "</done>"
done-char ::= [^<] | "<" [^/] | "</" [^d] | "</d" [^o] | "</do" [^n] | "</don" [^e] | "</done" [^>]
tool-call ::= "<tool_call>" ws "{" ws "\"name\"" ws ":" ws tool-name ws "," ws "\"arguments\"" ws ":" ws json-object ws "}" ws "</tool_call>"
tool-name ::= ${toolNames.map((name) => JSON.stringify(JSON.stringify(name))).join(" | ")}
json-object ::= "{" ws (json-string ws ":" ws json-value ("," ws json-string ws ":" ws json-value)*)? "}"
json-array ::= "[" ws (json-value ("," ws json-value)*)? "]"
json-value ::= (json-object | json-array | json-string | json-number | "true" | "false" | "null") ws
json-string ::= "\"" ([^"\\\x00-\x1f] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4}))* "\""
json-number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [+-]? [0-9]+)?
ws ::= [ \t\n\r]*`;
