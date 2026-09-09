# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Tags support escaped `{{path}}` and raw `{{{path}}}` interpolation, comments,
nested `if`/`else` blocks, and array `each`/`else` blocks. Inside `each`, use
`{{this}}` and `{{@index}}`; named paths first inspect the current item and then
fall back to root data.

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

Output contains only rendered text. Errors are written to stderr with a non-zero
exit status. Run the self-tests with `bun test`.
