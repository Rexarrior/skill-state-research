# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes scalar values, while `{{{path}}}` inserts them raw. The renderer also supports comments (`{{! ... }}`), nested `if` blocks, and nested `each` blocks with `{{this}}`, `{{@index}}`, and `{{else}}` branches. Missing values become empty strings; interpolating objects or functions is an error.

Run from the command line:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is written to stdout. Diagnostics are written to stderr with a non-zero exit status.

Run the self-tests with `bun test`.
