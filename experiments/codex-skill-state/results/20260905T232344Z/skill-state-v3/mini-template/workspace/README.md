# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax:

- `{{path.to.value}}` inserts an HTML-escaped scalar value.
- `{{{path.to.value}}}` inserts an unescaped scalar value.
- `{{#if path}}...{{else}}...{{/if}}` conditionally renders a branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates arrays. Use `{{this}}`, `{{this.field}}`, and `{{@index}}` inside a loop. Normal paths first use the current item and then fall back to root data.
- `{{! comment }}` emits nothing.

Missing values render as empty strings. Objects, arrays, functions, and symbols cannot be interpolated directly and produce an error with a source location.

Run the CLI with two UTF-8 files:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is the only stdout output. Diagnostics are written to stderr with a non-zero exit status.

Run the self-tests:

```sh
bun test
```
