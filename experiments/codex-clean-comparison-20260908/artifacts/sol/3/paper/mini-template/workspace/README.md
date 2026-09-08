# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}`, raw `{{{path}}}`, comments `{{! ... }}`,
conditionals (`{{#if path}}...{{else}}...{{/if}}`), and array iteration
(`{{#each path}}...{{else}}...{{/each}}`). In loops, use `{{this}}` and
`{{@index}}`; ordinary paths use the current item and then fall back to root data.

Run the CLI with:

```sh
bun run src/cli.ts template.txt data.json
```

Run self-tests with `bun test` and type-check with `bun run typecheck`.
