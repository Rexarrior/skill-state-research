# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{name}}!", { name: "Ada & friends" });
// Hello, Ada &amp; friends!
```

```sh
bun run src/cli.ts template.html data.json
bun test
```

The CLI reads UTF-8 files, writes the exact rendered text to stdout, and reports
errors on stderr with a nonzero exit code.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if enabled}}yes{{else}}no{{/if}}` supports nested blocks. Empty strings,
  zero, false, null, undefined, NaN, and empty arrays are false.
- `{{#each users}}{{@index}}: {{this.name}}{{else}}No users{{/each}}`
  iterates arrays. Empty arrays and non-arrays use the optional `else` branch.
- Inside loops, normal paths first resolve against the current item, then the
  root if absent. `this` explicitly selects the current item; outside loops it
  selects the root. Nested loops use their own item and index, restoring the
  enclosing context afterward. An `each` fallback keeps the enclosing context.
- Paths use dot-separated own properties, including numeric array indices.
  Inherited properties are not exposed. An existing null or undefined property
  does not fall back to the root.
- `{{! comment }}` emits nothing. All text outside tags is preserved exactly.

Missing, null, and undefined values interpolate as empty text. Other primitives
convert to strings; arrays, objects, and functions throw a scalar-rendering
error. Syntax errors include a line and column, even in unused branches.
No expressions, JavaScript evaluation, or third-party packages are used.
