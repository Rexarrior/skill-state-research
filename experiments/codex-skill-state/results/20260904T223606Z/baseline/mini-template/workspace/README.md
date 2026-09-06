# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes scalar values, while `{{{path}}}` leaves them untouched.
Use `{{#if path}}...{{else}}...{{/if}}` for conditionals and
`{{#each path}}...{{else}}...{{/each}}` for arrays. Within an `each` block,
`{{this}}` is the item and `{{@index}}` is its index; other paths resolve from
the root data object. Comments use `{{! comment }}`.

Run a file-based template with:

```sh
bun run src/cli.ts TEMPLATE_FILE DATA.json
```

The CLI writes only rendered output to standard output. Errors are written to
standard error with a non-zero exit status. Run self-tests with `bun test`.
