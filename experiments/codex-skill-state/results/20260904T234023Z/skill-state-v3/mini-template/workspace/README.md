# Mini Template

A dependency-free TypeScript template renderer for Bun. It supports escaped (`{{name}}`) and raw (`{{{name}}}`) paths, comments, nested `if` blocks, and array `each` blocks with `this` and `@index`.

```ts
import { render } from "./src/engine";

render("Hello {{user.name}}!", { user: { name: "Ada" } });
```

Run the CLI with UTF-8 template and JSON data files:

```sh
bun run src/cli.ts TEMPLATE_FILE DATA.json
```

Run checks with `bun test` and `bunx tsc --noEmit`.
