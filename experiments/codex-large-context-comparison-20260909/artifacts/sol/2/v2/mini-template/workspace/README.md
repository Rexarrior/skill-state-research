# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes values, while `{{{path}}}` emits raw text. Conditional blocks use `{{#if path}}...{{else}}...{{/if}}`; array loops use `{{#each path}}...{{else}}...{{/each}}`. Within a loop, `{{this}}`, `{{this.field}}`, and `{{@index}}` refer to the current item. Ordinary paths first use the item and then fall back to root data. Comments use `{{! comment }}`.

Run the CLI with two UTF-8 input files:

```sh
bun run src/cli.ts template.txt data.json
```

Only rendered output is written to stdout. Syntax, file, JSON, and rendering errors are written to stderr with a non-zero exit status.

Run the self-tests and type checker:

```sh
bun test
bun run typecheck
```
