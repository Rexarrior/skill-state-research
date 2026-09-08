# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "<Ada>" }); // Hello, &lt;Ada&gt;!
```

Run the CLI with `bun run src/cli.ts template.html data.json`. It reads UTF-8
files and writes the rendered text without an added newline. Errors go to stderr
and produce a non-zero exit status. Run the self-tests with `bun test`.

- `{{user.name}}` inserts scalar text, escaping `& < > " '`. Use
  `{{{user.name}}}` for raw text.
- `{{#if enabled}}yes{{else}}no{{/if}}` selects a branch. Empty strings,
  zero, false, null, undefined, and empty arrays are false (as is NaN).
- `{{#each users}}{{@index}}: {{name}} / {{this.name}}{{else}}Nobody{{/each}}`
  iterates arrays. Empty arrays and non-array values use the optional else branch.
- `{{this}}` refers to the current item, or the root data outside a loop.
  Ordinary paths first check the current item, then the root if the path is absent.
  An explicitly present null or undefined value does not fall back. `this.*` never
  falls back. Only own properties are accessible; numeric path segments index arrays.
- Blocks nest freely. Nested loops use their own item and index and restore the
  outer context afterward. An each else branch retains the surrounding context.
- `{{! comment }}` emits nothing. Whitespace outside tags is preserved exactly;
  whitespace around a tag's expression is ignored.

Missing and null interpolation values produce empty text. Objects, arrays, and
functions cannot be interpolated and raise an error. Structural errors are checked
even in unused branches. Template errors include a one-based line and column.
No expressions are evaluated; paths are dot-separated property names.
