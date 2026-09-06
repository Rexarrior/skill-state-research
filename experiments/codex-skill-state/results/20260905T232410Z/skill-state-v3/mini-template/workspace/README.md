# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes values and `{{{path}}}` emits raw scalar text. The
engine supports nested `if` and `each` blocks with optional `else` branches,
comments (`{{! ... }}`), `{{this}}`, and `{{@index}}`. Inside loops, ordinary
paths first inspect the current item and then fall back to the root data.

```text
{{#each users}}{{@index}}: {{name}}{{else}}No users{{/each}}
{{#if enabled}}on{{else}}off{{/if}}
```

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is the only stdout output. Syntax, file, JSON, and rendering
errors are written to stderr with a non-zero exit status.

Run the self-tests with `bun test`.
