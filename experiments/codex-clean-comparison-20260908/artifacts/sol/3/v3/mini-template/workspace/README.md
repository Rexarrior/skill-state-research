# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes scalar values, while `{{{path}}}` inserts them unchanged. Conditions use `{{#if path}}...{{else}}...{{/if}}`. Arrays use `{{#each path}}...{{else}}...{{/each}}`, with `{{this}}` and `{{@index}}` available inside the loop. Blocks may be nested, normal paths continue to address the root data, and `{{! comments }}` are omitted.

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Parse, file, and data errors are written to stderr and result in a non-zero exit status.

Run the self-tests with:

```sh
bun test
```
