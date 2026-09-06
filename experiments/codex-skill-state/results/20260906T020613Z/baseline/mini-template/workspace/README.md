# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}` and raw `{{{path}}}` interpolation,
`{{#if path}}...{{else}}...{{/if}}`, array iteration with
`{{#each path}}...{{else}}...{{/each}}`, `{{this}}`, `{{@index}}`, and
`{{! comments }}`. Blocks can be nested. Paths inside a loop first resolve
against the current item (then enclosing items), and finally the root data.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Errors are written to stderr with a
non-zero exit status.

Run the self-tests:

```sh
bun test
```
