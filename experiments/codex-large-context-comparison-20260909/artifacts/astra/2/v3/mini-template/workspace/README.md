# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";
render("Hello, {{name}}!", { name: "Ada & friends" });
// Hello, Ada &amp; friends!
```

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
bun test
```

The CLI writes exactly the rendered text to stdout, without adding a newline.
Errors go to stderr with a nonzero exit status.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if path}}yes{{else}}no{{/if}}` tests a value. Empty strings, zero,
  false, null, undefined, NaN, missing values, and empty arrays are false.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}`
  iterates arrays. Non-arrays and empty arrays use the optional else branch.
- Blocks may nest. `this` refers to the current item (the root outside loops),
  and `@index` is the innermost loop index. Normal dotted paths first look in
  the current item, then fall back to the root when missing. An explicit null
  or undefined value does not trigger fallback. An inner loop's else branch
  keeps the surrounding context. Parent-loop paths are not supported.
- `{{! comment }}` emits nothing. Whitespace outside tags is unchanged.

Paths access own properties only; numeric segments can index arrays. Tags trim
surrounding whitespace. Missing, null, and undefined interpolations are empty.
Other scalar values become text; objects, arrays, and functions cause an error.
No expressions or JavaScript evaluation are supported. Structural errors are
validated even in inactive branches and include a one-based line and column.
