// The single source of the server's public tool count. src/index.ts's
// TOOL_COUNT (reported in GET /health and asserted by src/index.test.ts's
// tools/list checks) and scripts/gen-docs.ts's buildHealthExample (the
// README's GET /health example) both read it from here, so the two can
// never drift the way a literal 9 in one file and a literal 10 in the
// other did (task 2 review finding).
//
// Kept as a literal rather than introspected from the SDK: tools/list must
// not vary per connection, so this is a fixed fact about the tools
// registered in src/index.ts's createServer(), not a runtime measurement.
// Bump this when a tool is added or removed there.
export const TOOL_COUNT = 11;
