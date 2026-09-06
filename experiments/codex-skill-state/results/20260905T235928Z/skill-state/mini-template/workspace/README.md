# Mini Template

A small dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada" }); // Hello, Ada!
```

Supported tags are escaped `{{path}}` interpolation, raw `{{{path}}}` interpolation,
`{{#if path}}...{{else}}...{{/if}}`, array iteration with
`{{#each path}}...{{else}}...{{/each}}`, and `{{! comments }}`. Within an `each`,
`{{this}}` names the item and `{{@index}}` its zero-based index. Blocks may nest.

Run the CLI with two UTF-8 files:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered result is the only stdout output. Errors are written to stderr and
produce a non-zero exit code.

Run the self-tests:

```sh
bun test
```
