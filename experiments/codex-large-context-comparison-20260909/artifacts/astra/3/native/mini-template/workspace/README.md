# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{name}}!", { name: "<Ada>" }); // Hello, &lt;Ada&gt;!
```

Run the CLI with two UTF-8 files:

```sh
bun run src/cli.ts template.txt data.json
bun test
```

The CLI writes the exact rendered text to stdout, without adding a newline. Errors
go to stderr with a nonzero exit status.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if ready}}yes{{else}}no{{/if}}` selects a branch. Empty strings, zero,
  false, null, undefined, NaN, and empty arrays are false. Other values are true.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays. Empty arrays and non-arrays use the optional `else` branch.
- Inside a loop, `this` is the current item and `@index` is its index. Ordinary
  paths resolve against the current item, then the root if the result is undefined.
  Nested loops use their own item and index, restoring the outer context afterward.
  They do not implicitly search parent items. Outside loops, `this` is the root.
- Paths are dot-separated own properties (including numeric array indexes).
  Segments may contain letters, digits, underscores, `$`, and hyphens. Inherited
  properties are not exposed. Whitespace around tag contents is ignored.
- `{{! comment }}` emits nothing. All text outside tags is preserved exactly.
- Missing and null values interpolate as empty text. Other scalar values convert
  to strings; objects, arrays, and functions raise an error when interpolated.

Blocks can nest and `else` is optional. Templates are fully parsed before rendering,
so structural errors are reported even in inactive branches. Syntax and invalid
interpolation errors include the tag's one-based line and column.
