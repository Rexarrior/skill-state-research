# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{name}}!", { name: "Ada & friends" });
// Hello, Ada &amp; friends!
```

Run the CLI with `bun run src/cli.ts template.txt data.json`. Both files are read
as UTF-8. Stdout contains only the rendered text, without an added newline;
errors go to stderr with a non-zero exit status.

- `{{user.name}}` inserts escaped text; `{{{user.name}}}` inserts raw text.
- `{{#if active}}yes{{else}}no{{/if}}` selects a branch. Empty strings, zero,
  false, null, undefined, and empty arrays are false; all other values are true.
- `{{#each users}}{{@index}}: {{this.name}}{{else}}Nobody{{/each}}` iterates
  arrays. Empty arrays and non-arrays select the optional `else` branch.
- `{{! comment }}` emits nothing. All text outside tags is preserved exactly.

Blocks can nest. Inside a loop, normal dotted paths first look in the current
item, then fall back to root data when the full path is missing. `this` explicitly
selects the current item (or root data outside loops); `@index` refers to the
innermost loop. After a nested loop, the outer context is restored. An `each`
fallback branch retains its surrounding context. Only own properties are read.
Paths use dots, including numeric array indices; bracket expressions and other
expressions are unsupported. Whitespace around tag contents is ignored.

Missing values and null render as empty text. Other scalar values are converted
to strings. Interpolating objects, arrays, or functions throws a clear error.
Syntax errors include a one-based line and column and are detected even in
branches that would not be rendered. Raw interpolation performs no escaping;
use it only when the inserted content is trusted.

Run the renderer and CLI self-tests with `bun test`.
