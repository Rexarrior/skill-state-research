# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}`, raw `{{{path}}}`, comments
`{{! comment }}`, conditionals with `{{#if path}}...{{else}}...{{/if}}`, and
array iteration with `{{#each path}}...{{else}}...{{/each}}`. Each blocks expose
`{{this}}` and `{{@index}}`; blocks may be nested.

Run the CLI with two UTF-8 input files:

```sh
bun run src/cli.ts template.txt data.json
```

Run the tests with `bun test`.
