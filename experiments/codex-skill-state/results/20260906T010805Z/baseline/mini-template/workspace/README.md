# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax:

- `{{path}}` for HTML-escaped interpolation and `{{{path}}}` for raw text
- `{{#if path}}...{{else}}...{{/if}}`
- `{{#each path}}...{{else}}...{{/each}}`, with `{{this}}` and `{{@index}}`
- `{{! comments }}`

Normal paths inside an `each` item resolve against that item first and then the root data. Missing values render as empty text. Objects and functions cannot be interpolated.

Run the CLI:

```sh
bun run src/cli.ts template.txt data.json
```

Run tests:

```sh
bun test
```
