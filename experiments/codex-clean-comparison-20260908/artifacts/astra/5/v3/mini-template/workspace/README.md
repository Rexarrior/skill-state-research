# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";
render("Hello, {{name}}!", { name: "Ada & friends" });
// Hello, Ada &amp; friends!
```

Run the CLI with `bun run src/cli.ts TEMPLATE_FILE DATA.json`. It reads UTF-8
files and writes the rendered text without an added newline. Errors go to stderr
with a nonzero exit code. Run the self-tests with `bun test`.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if path}}yes{{else}}no{{/if}}` supports nesting. Empty strings, numeric zero,
  false, null, undefined, and empty arrays are false; other values are true.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates arrays.
  Non-arrays and empty arrays use the optional `else` branch.
- Inside a loop, ordinary paths resolve on the current item first, then on the
  root if the path is absent. An explicit null or undefined does not fall back.
  `this` always selects the current item (the root outside loops). Nested loops
  have their own item and index; after a loop, the enclosing context is restored.
- Paths traverse own properties only. `{{! comment }}` emits nothing.

Whitespace outside tags is preserved. Missing and null values produce empty text;
other scalar values use their string representation. Arrays, objects, and functions
cannot be interpolated and raise an error. Structural errors include a line and
column, even in branches that would not render. Raw interpolation should only be
used with content you trust to insert without HTML escaping.
