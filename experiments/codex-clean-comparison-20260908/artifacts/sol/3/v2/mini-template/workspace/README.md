# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}` and raw `{{{path}}}` interpolation,
`{{#if path}}...{{else}}...{{/if}}`, array iteration with
`{{#each path}}...{{else}}...{{/each}}`, and `{{! comments }}`. Each blocks expose
`{{this}}` and `{{@index}}`; ordinary paths use the current item and then fall
back to root data. Blocks may be nested.

Run the CLI with a template file and a JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Only rendered text is written to standard output. Errors are written to standard
error and produce a non-zero exit status.

Run the self-tests with:

```sh
bun test
```
