# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}` interpolation, raw `{{{path}}}` interpolation, nested `{{#if path}}...{{else}}...{{/if}}` and `{{#each path}}...{{else}}...{{/each}}` blocks, and `{{! comments }}`. Each blocks expose `{{this}}` and `{{@index}}`; ordinary paths first use the current item and then the root object.

Run the CLI with two UTF-8 files:

```sh
bun run src/cli.ts template.txt data.json
```

Run the self-tests with `bun test` and the type check with `bun run typecheck`.
