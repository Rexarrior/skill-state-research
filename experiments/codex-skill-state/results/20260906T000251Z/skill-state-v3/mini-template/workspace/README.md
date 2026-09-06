# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax:

- `{{path.to.value}}` — HTML-escaped interpolation.
- `{{{path.to.value}}}` — raw interpolation.
- `{{#if path}}...{{else}}...{{/if}}` — conditional blocks.
- `{{#each path}}...{{else}}...{{/each}}` — array iteration with `{{this}}` and `{{@index}}`.
- `{{! comment }}` — comments.

Blocks can be nested. In an `each` block, paths beginning with `this` refer to the current item; other paths refer to the root data.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Errors are written to stderr and result in a non-zero exit code.

## Test

```sh
bun test
bunx tsc --noEmit
```
