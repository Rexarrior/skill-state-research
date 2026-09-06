# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax: escaped `{{path}}`, raw `{{{path}}}`, comments
`{{! ... }}`, nested `if` blocks, and nested `each` blocks with `{{this}}`,
`{{@index}}`, `{{else}}`, and root-value fallback.

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

Run the self-tests:

```sh
bun test
```
