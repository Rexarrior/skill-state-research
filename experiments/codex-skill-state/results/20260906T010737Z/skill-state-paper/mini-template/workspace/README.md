# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada" });
```

Supported tags are escaped `{{path}}` and raw `{{{path}}}` interpolation,
`{{#if path}}...{{else}}...{{/if}}`, array iteration with
`{{#each path}}...{{else}}...{{/each}}`, `{{this}}`, `{{@index}}`, and
`{{! comments }}`. Blocks may be nested. Ordinary paths inside an `each` first
look at the current item and then fall back to the root data object.

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

Only rendered text is written to stdout. Errors are written to stderr and set a
non-zero exit status.

Run the self-tests with:

```sh
bun test
```
