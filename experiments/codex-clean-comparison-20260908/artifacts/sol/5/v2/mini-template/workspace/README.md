# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes values, while `{{{path}}}` inserts raw scalar text. Conditionals use
`{{#if path}}...{{else}}...{{/if}}`; empty strings, zero, false, null, undefined, and empty arrays are false.
Array loops use `{{#each path}}...{{else}}...{{/each}}`. Within a loop, `{{this}}` is the item and
`{{@index}}` is its zero-based index. Item properties are resolved before root properties. Blocks may be nested,
`{{! comments }}` are removed, and all text outside tags is preserved exactly.

Objects, arrays, functions, and other non-scalar interpolation values throw an error. Missing values render as an
empty string. Template structure errors include a line and column.

Run the CLI with two UTF-8 input files:

```sh
bun run src/cli.ts template.txt data.json
```

It writes only rendered text to stdout. Errors are written to stderr and result in a non-zero exit code.

Run the tests:

```sh
bun test
```
