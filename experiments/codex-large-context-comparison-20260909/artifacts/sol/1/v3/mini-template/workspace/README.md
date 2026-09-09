# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes values, while `{{{path}}}` emits raw scalar text. The language also supports comments, nested `if`/`else` blocks, and array `each`/`else` blocks. Within a loop, use `{{this}}`, `{{@index}}`, or fields on the current item; unresolved paths fall back to the root data.

```text
{{#if active}}enabled{{else}}disabled{{/if}}
{{#each users}}{{@index}}: {{name}}{{else}}No users{{/each}}
{{! this is omitted }}
```

Run from the command line with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Usage, file, JSON, template, and rendering errors are written to stderr and produce a non-zero exit code.

Run the self-tests with:

```sh
bun test
```
