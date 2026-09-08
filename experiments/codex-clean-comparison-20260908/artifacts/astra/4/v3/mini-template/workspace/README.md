# Mini Template

A dependency-free TypeScript template renderer for Bun. No installation step is needed.

```ts
import { render } from "./src/engine";

render("Hello {{name}}!", { name: "<Ada>" }); // Hello &lt;Ada&gt;!
```

Run `bun run src/cli.ts TEMPLATE_FILE DATA.json` to render UTF-8 files. Stdout contains only the result, with no added newline. Errors go to stderr and return a non-zero exit code.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if user}}yes{{else}}no{{/if}}` selects a branch. Empty strings, zero, false, null, undefined, and empty arrays are false (including bigint zero); all other values are true.
- `{{#each users}}{{@index}}: {{this.name}}{{else}}Nobody{{/each}}` iterates arrays. Missing, empty, or non-array values use the optional else branch.
- Blocks can nest. `this` refers to the current item (or root outside loops); `@index` refers to the innermost active loop. After a nested loop, the outer context is restored. An each else branch retains its surrounding context.
- Normal paths start on the current item if it owns the first segment, otherwise on the root. `this.name` never falls back. Only own properties are visible; dotted numeric array indices are supported. Paths do not evaluate expressions.
- `{{! comment }}` emits nothing. Whitespace outside tags is preserved exactly.

Missing and null interpolations produce empty text. Strings, numbers, booleans, and bigints render as text; objects, arrays, functions, and symbols throw clear errors. Syntax errors include a one-based line and column; all branches are parsed, including inactive ones. Raw interpolation does no HTML escaping, so use it only for content you intend to insert as HTML.

Run the renderer and CLI self-tests with `bun test`.
