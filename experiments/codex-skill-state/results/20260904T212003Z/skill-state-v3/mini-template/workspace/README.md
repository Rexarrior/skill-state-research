# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax:

- `{{path.to.value}}` — HTML-escaped interpolation
- `{{{path.to.value}}}` — raw interpolation
- `{{#if path}}...{{else}}...{{/if}}` — conditional blocks
- `{{#each path}}...{{else}}...{{/each}}` — array iteration
- `{{this}}` and `{{@index}}` — current loop item and index
- `{{! comment }}` — comments

Blocks may be nested. Within a loop, paths are looked up on the current item first and then on the root data object. Missing values produce an empty string; interpolating objects or functions is an error.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Usage, file, JSON, template, and rendering errors are written to stderr with a non-zero exit status.

## Tests

```sh
bun test
```
