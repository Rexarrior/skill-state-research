# Mini Template

A small, dependency-free template renderer for Bun and TypeScript.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes values, while `{{{path}}}` leaves them unchanged. The
engine supports nested `if` and `each` blocks, `else`, comments, `this`, and
`@index`. Missing values become empty strings; interpolating non-scalar values
and malformed block structure produces a source-located error.

Run the CLI with two UTF-8 files:

```sh
bun run src/cli.ts template.txt data.json
```

Only rendered output is written to stdout. Errors are written to stderr and
return a non-zero status.

Run self-tests with `bun test` and type-check with `bun run typecheck`.
