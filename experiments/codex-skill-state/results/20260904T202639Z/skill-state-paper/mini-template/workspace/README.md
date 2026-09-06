# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes scalar values, while `{{{path}}}` leaves them raw. The renderer also supports nested `{{#if path}}...{{else}}...{{/if}}` and `{{#each path}}...{{else}}...{{/each}}` blocks, comments (`{{! ... }}`), `{{this}}`, and `{{@index}}`. Missing values produce no text; interpolating objects, arrays, or functions throws an error.

Render UTF-8 files from the command line:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered document is the only stdout output. Errors are written to stderr with a non-zero exit status.

Run the tests with `bun test`.
