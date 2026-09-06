# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes scalar values and `{{{path}}}` inserts them unchanged. The engine also supports nested `{{#if path}}...{{else}}...{{/if}}` and `{{#each path}}...{{else}}...{{/each}}` blocks, `{{this}}`, `{{@index}}`, and `{{! comments }}`. Missing values become empty strings; object and function interpolation is rejected.

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is the only stdout output. Errors are written to stderr with a non-zero exit status.

Run the self-tests:

```sh
bun test
```
