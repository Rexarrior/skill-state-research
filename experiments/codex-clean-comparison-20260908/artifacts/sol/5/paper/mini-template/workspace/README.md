# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes scalar values, while `{{{path}}}` leaves them raw. The language also supports comments (`{{! ... }}`), nested `{{#if path}}...{{else}}...{{/if}}` blocks, and array `{{#each path}}...{{else}}...{{/each}}` blocks. Within a loop, use `{{this}}` and `{{@index}}`; ordinary paths check the current item and then the root data.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Run the self-tests with `bun test`.
