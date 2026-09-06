# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}`, raw `{{{path}}}`, `if` and `each`
blocks with optional `else`, and `{{! comments }}`. In an `each` block,
`{{this}}` and `{{@index}}` refer to the current item and index.

Run the CLI with:

```sh
bun run src/cli.ts template.txt data.json
```

It writes only rendered text to stdout. Run the self-tests with `bun test`.
