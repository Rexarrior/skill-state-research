# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes interpolated scalar values, while `{{{path}}}` leaves
them unchanged. The language also supports comments, nested `if`/`else` blocks,
and array `each`/`else` blocks. Within a loop, `{{this}}` and `{{@index}}` refer
to the current item and index. Named paths first use the current item and then
fall back to the root data.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Diagnostics are written to stderr and use a
non-zero exit status. Run the self-tests with `bun test`.
