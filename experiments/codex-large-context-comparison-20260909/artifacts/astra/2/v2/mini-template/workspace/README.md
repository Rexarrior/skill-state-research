# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello {{name}}!", { name: "Ada & friends" });
// Hello Ada &amp; friends!
```

Run the CLI with `bun run src/cli.ts TEMPLATE_FILE DATA.json`. Both files are
read as UTF-8. Success writes exactly the rendered text, without an added newline.
Errors go to stderr and set a nonzero exit code. Run self-tests with `bun test`.
No installation or third-party packages are needed.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- Missing values and null render as empty text. Strings, numbers, booleans,
  bigints, and symbols render as text; objects, arrays, and functions throw.
- `{{#if path}}yes{{else}}no{{/if}}` uses JavaScript truthiness, except empty
  arrays are false. Blocks can nest and `else` is optional.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}`
  iterates arrays. Missing, empty, or non-array values use the `else` branch.
- Inside loops, `this` and `@index` refer to the innermost item and index.
  Normal paths first look up the complete path on that item, then fall back
  to the root if missing. An explicitly present null or undefined does not
  trigger fallback. Outer loop context is restored after nested loops.
  Outside loops, `this` refers to the root and `@index` is missing.
- Paths use dot-separated own properties (including numeric array indices);
  inherited properties are not exposed. There are no expressions or helpers.
- `{{! comment }}` emits nothing. Tag-edge whitespace is ignored; all text
  outside tags is preserved exactly.

Malformed tags and block structures throw errors with a one-based line and
column, even in branches that would not render. Non-scalar interpolation errors
also identify the path and location. Raw interpolation intentionally bypasses
HTML escaping; use it only for content you trust.
