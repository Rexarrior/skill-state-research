# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}` and raw `{{{path}}}` interpolation,
`{{#if path}}...{{else}}...{{/if}}`, array iteration with
`{{#each path}}...{{else}}...{{/each}}`, `{{this}}`, `{{@index}}`, and
`{{! comments }}`. Blocks may be nested and whitespace is preserved.

Run the CLI with a template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Run the self-tests with `bun test`.
