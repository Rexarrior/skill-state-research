# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{name}}!", { name: "Ada & Bob" });
// Hello, Ada &amp; Bob!
```

Supported syntax:

- `{{path.to.value}}` for HTML-escaped interpolation and `{{{path}}}` for raw text
- `{{#if path}}...{{else}}...{{/if}}` for conditionals
- `{{#each path}}...{{else}}...{{/each}}` for arrays
- `{{this}}` and `{{@index}}` inside loops
- `{{! comment }}` for comments

Within a loop, normal paths first address the current item and then fall back to
the root data object. Missing values render as empty text. Interpolating an object
or function throws an error.

Run the CLI with two UTF-8 files:

```sh
bun run src/cli.ts template.txt data.json
```

Run the self-tests with `bun test`.
