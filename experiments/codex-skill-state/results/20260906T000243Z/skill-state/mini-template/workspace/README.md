# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Interpolations with `{{path}}` HTML-escape their output; triple braces such as
`{{{html}}}` do not. The renderer supports nested `if` and `each` blocks,
`else`, comments, `this`, and `@index`. Missing values become empty strings.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Errors are written to stderr and produce a
non-zero exit status.

Run the test suite with:

```sh
bun test
```
