# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}` and raw `{{{path}}}` interpolation,
`{{#if path}}...{{else}}...{{/if}}`, array iteration with
`{{#each path}}...{{else}}...{{/each}}`, and `{{! comments }}`. Each blocks
provide `{{this}}` and `{{@index}}`; ordinary paths first use the current item
and then fall back to root data.

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

Run the self-tests with `bun test`.
