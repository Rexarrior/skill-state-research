# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes scalar values and `{{{path}}}` inserts them verbatim. The renderer also supports nested `{{#if path}}...{{else}}...{{/if}}` and `{{#each path}}...{{else}}...{{/each}}` blocks, `{{this}}`, `{{@index}}`, dotted paths, and `{{! comments }}`. Missing values become empty strings; interpolating objects, arrays, or functions throws a descriptive error.

Run the CLI with two UTF-8 input files:

```sh
bun run src/cli.ts template.txt data.json
```

Only rendered content is written to stdout. Invalid arguments, files, JSON, or templates are reported on stderr with a non-zero exit status.

Run the self-tests with `bun test`.
