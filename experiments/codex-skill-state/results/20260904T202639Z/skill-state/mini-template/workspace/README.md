# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes scalar values, while `{{{path}}}` inserts them raw.
Conditionals use `{{#if path}}...{{else}}...{{/if}}`; array iteration uses
`{{#each path}}...{{else}}...{{/each}}`. Within an iteration, `{{this}}` is the
item and `{{@index}}` its zero-based index. Blocks may be nested, comments use
`{{! comment }}`, and whitespace is preserved.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout; diagnostics are written to stderr. Run the
self-tests with `bun test`.
