# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes values, while `{{{path}}}` inserts raw scalar text. The
engine supports nested `{{#if path}}...{{else}}...{{/if}}` and
`{{#each path}}...{{else}}...{{/each}}` blocks, plus `{{! comments }}`. Within
an each block, use `{{this}}` and `{{@index}}`; ordinary paths first inspect the
current item and then fall back to the root data.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered result is the only stdout output. Errors are written to stderr and
set a non-zero exit status.

Run the self-tests with `bun test`.
