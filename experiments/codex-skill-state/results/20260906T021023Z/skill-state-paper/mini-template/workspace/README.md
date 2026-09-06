# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada" });
```

`{{path}}` HTML-escapes values, while `{{{path}}}` inserts raw scalar text. The renderer supports nested `{{#if path}}...{{else}}...{{/if}}` and `{{#each path}}...{{else}}...{{/each}}` blocks, comments with `{{! ... }}`, plus `{{this}}` and `{{@index}}` inside loops. Missing values become empty strings. Objects and functions cannot be interpolated.

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is the only stdout output. Errors are written to stderr with a non-zero exit status.

Run the self-tests:

```sh
bun test
```
