# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{name}}!", { name: "Ada & Lin" });
// Hello, Ada &amp; Lin!
```

```sh
bun run src/cli.ts template.html data.json
bun test
```

The CLI reads UTF-8 files, writes the rendered text without an added newline,
and reports errors to stderr with a nonzero exit status.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if value}}yes{{else}}no{{/if}}` supports nested blocks. Empty strings,
  zero (including bigint zero), false, null, undefined, and empty arrays are false;
  all other values are true.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays. Empty arrays and non-arrays use the optional `else` branch.
- Inside loops, normal paths first resolve against the current item, then
  fall back to the root when the path is missing. `this` always refers to the
  current item (or root outside loops). Nested loops have their own `@index`
  and restore the outer context afterward. An `each` fallback keeps its
  enclosing context. `@index` outside loops is missing.
- Paths use dots, support numeric array indices, and access only own properties.
  An explicitly present null or undefined value does not trigger root fallback.
- `{{! comment }}` emits nothing. Text outside tags is preserved exactly.
- Missing/null/undefined interpolations are empty. Strings, numbers, booleans,
  and bigints render as text; objects, arrays, functions, and symbols throw.

Structural errors and unsupported interpolations report one-based line and
column positions. The full template is parsed before rendering, including
branches that will not execute. Expressions and executable code are unsupported.
