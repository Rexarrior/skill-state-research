# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "A&B" }); // Hello, A&amp;B!
```

Run the CLI with `bun run src/cli.ts TEMPLATE_FILE DATA.json`. It reads UTF-8,
writes the exact rendered text to stdout (no added newline), and reports errors
to stderr with a non-zero exit status. Run self-tests with `bun test`.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if value}}yes{{else}}no{{/if}}` supports nested blocks. Empty strings,
  zero, false, null, undefined, and empty arrays are false; all other values are true.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays; missing, empty, or non-array values select the optional else branch.
- Inside loops, `this` is the current item and `@index` is its zero-based index.
  Normal paths look in the current item, then fall back to the root when the
  full path is absent. An existing null or undefined value shadows the root.
  `this.name` never falls back. Nested loops restore the outer context on exit;
  an empty loop's else branch retains its surrounding context.
- `{{! comment }}` emits nothing. All text outside tags is preserved exactly.

Paths are dot-separated own-property names (numeric array indexes work).
Inherited properties are not exposed. Missing and null interpolation values
produce empty text. Strings, numbers, booleans, bigints, and symbols render as
text; arrays, objects, and functions throw a scalar-text error. Structural and
interpolation errors include a one-based line and column. Templates are parsed
fully, including inactive branches. There are no expressions or code evaluation.
