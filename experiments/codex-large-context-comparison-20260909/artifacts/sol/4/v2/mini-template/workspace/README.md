# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "<Bun>" });
// Hello, &lt;Bun&gt;!
```

Supported syntax:

- `{{path.to.value}}` renders HTML-escaped scalar text.
- `{{{path.to.value}}}` renders unescaped scalar text.
- `{{#if path}}...{{else}}...{{/if}}` conditionally renders a branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates arrays. `{{this}}` and `{{@index}}` are loop locals; other paths read from the root data.
- `{{! comment }}` renders nothing.

Missing values render as empty strings. Objects, arrays, functions, and symbols cannot be interpolated directly. Malformed template structures throw errors with line and column information.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is written to stdout. File, JSON, usage, and template errors are written to stderr with a non-zero exit status.

## Tests

```sh
bun test
```
