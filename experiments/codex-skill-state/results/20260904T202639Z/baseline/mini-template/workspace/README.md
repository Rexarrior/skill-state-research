# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada & Lin" } });
// Hello, Ada &amp; Lin!
```

Supported syntax:

- `{{path.to.value}}` for HTML-escaped interpolation and `{{{path}}}` for raw interpolation
- `{{#if path}}...{{else}}...{{/if}}` with nested blocks
- `{{#each path}}...{{else}}...{{/each}}` for arrays; `{{this}}` and `{{@index}}` describe the current item
- `{{! comment }}` for comments

Within loops, paths are looked up on the current item and then fall back to the root data. Missing values render as an empty string. Interpolating objects, arrays, functions, or symbols throws an error.

Run the CLI (it does not append a newline):

```sh
bun run src/cli.ts template.txt data.json
```

Run the self-tests:

```sh
bun test
```
