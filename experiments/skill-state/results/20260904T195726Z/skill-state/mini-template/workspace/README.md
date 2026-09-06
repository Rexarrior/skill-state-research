# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax: escaped `{{path}}` and raw `{{{path}}}` interpolation, nested `if` and `each` blocks with optional `else`, `this`, `@index`, dotted paths, and `{{! comments }}`.

Run the CLI with:

```sh
bun run src/cli.ts template.txt data.json
```

It writes only rendered output to stdout. Run self-tests with `bun test` and type checking with `bun run typecheck`.
