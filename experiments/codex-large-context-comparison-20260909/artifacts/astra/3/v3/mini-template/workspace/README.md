# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";
render("Hello {{name}}!", { name: "Ada" }); // Hello Ada!
```

Run `bun run src/cli.ts TEMPLATE_FILE DATA.json`. Both files are read as UTF-8;
stdout contains exactly the rendered text with no added newline. Errors go to
stderr with a nonzero exit status. Run the self-tests with `bun test`.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if value}}yes{{else}}no{{/if}}` selects a branch. Empty strings, zero,
  false, null, undefined, NaN, and empty arrays are false. Other values are true.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays. Missing, empty, or non-array values select the optional else branch.
- Within loops, `this` is the item and `@index` is its zero-based index.
  Plain paths first resolve against the current item, then against the root
  if the path is missing. Explicit `this.name` never falls back. Nested loops
  use their own item and index; the outer context resumes afterward.
  Outside loops, `this` refers to the root and `@index` is missing.
- Paths use dot-separated identifiers or numeric array indices (`items.0.name`).
  Only own properties are accessible; inherited properties are not resolved.
- `{{! comment }}` emits nothing. All text outside tags is preserved exactly.

Blocks nest and may each have one `else`. Invalid syntax reports a line and
column (one-based). Missing values and null render as empty text; other scalar
values convert to strings. Objects, arrays, and functions cannot be interpolated
directly and raise a clear error. Input data is never mutated and no code is
evaluated. Templates and data should fit in memory.
