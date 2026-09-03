# Mini Template

Build a dependency-free TypeScript template renderer for Bun.

## Public API and CLI

- Export `render(template: string, data: unknown): string` from `src/engine.ts`.
- `bun run src/cli.ts TEMPLATE_FILE DATA.json` reads UTF-8 files and writes only the rendered text to stdout.
- CLI errors go to stderr and exit non-zero.

## Language

- `{{path.to.value}}` inserts an HTML-escaped value (`& < > " '` must be escaped).
- `{{{path.to.value}}}` inserts an unescaped value.
- `{{#if path}}...{{else}}...{{/if}}` supports nesting. Empty strings, zero, false, null, undefined, and empty arrays
  are false; other values are true.
- `{{#each path}}...{{else}}...{{/each}}` iterates arrays. Inside the block, `{{this}}` is the current item,
  `{{@index}}` is the zero-based index, and normal paths fall back to the root object. Nested loops must work.
- `{{! comment }}` emits nothing.
- Whitespace outside tags is preserved exactly.

Missing interpolation values render as an empty string. Structural mistakes (unknown block, mismatched/unclosed close,
duplicate `else`, `else` outside a block) throw errors with a useful line and column. Values that cannot sensibly be
rendered as scalar text (objects/functions) must produce a clear error rather than `[object Object]`.

Do not use `eval`, `Function`, or third-party packages. Include a concise `README.md` and run meaningful self-tests.
