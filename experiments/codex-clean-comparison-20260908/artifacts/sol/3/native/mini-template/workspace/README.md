# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes interpolated scalar values, while `{{{path}}}` inserts them unchanged. The renderer also supports `{{#if path}}...{{else}}...{{/if}}`, array iteration with `{{#each path}}...{{else}}...{{/each}}`, `{{this}}`, `{{@index}}`, nested blocks, and `{{! comments }}`. Missing values become empty strings. Objects, arrays, and functions cannot be interpolated directly.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is the only stdout output. Errors are written to stderr and return a non-zero status.

Run the self-tests with `bun test`.
