# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes values, while `{{{path}}}` leaves them unescaped. The
language also supports comments (`{{! ... }}`), nested `if` blocks, and array
`each` blocks with `{{this}}`, `{{@index}}`, and an optional `{{else}}` branch.

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

Only rendered text is written to stdout. Errors are written to stderr and use a
non-zero exit code.

Run the self-tests:

```sh
bun test
```
