# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}` and raw `{{{path}}}` interpolation,
`{{#if path}}...{{else}}...{{/if}}`, array iteration with
`{{#each path}}...{{else}}...{{/each}}`, and `{{! comments }}`. Within an
iteration, `{{this}}` is the item and `{{@index}}` is its zero-based index.
Paths first use the current item and then fall back to the root data.

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

It writes only rendered content to standard output. Errors are written to
standard error with a non-zero exit status. Run the self-tests with `bun test`.
