# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes scalar values, while `{{{path}}}` inserts them raw. The
renderer supports nested `{{#if path}}...{{else}}...{{/if}}` and
`{{#each path}}...{{else}}...{{/each}}` blocks, comments (`{{! ... }}`), dotted
root paths, and the loop locals `{{this}}`, `{{this.property}}`, and `{{@index}}`.
Missing values produce an empty string; objects and functions cannot be directly
interpolated.

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Errors are written to stderr with a non-zero
exit status. Run the self-tests with `bun test`.
