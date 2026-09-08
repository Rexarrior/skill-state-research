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

The CLI reads UTF-8 files, writes rendered text without an added newline, and
reports errors to stderr with a non-zero exit code.

- `{{user.name}}` escapes `& < > " '`; `{{{user.name}}}` inserts raw text.
- `{{#if enabled}}yes{{else}}no{{/if}}` supports nested blocks. Empty strings,
  zero, false, null, undefined, and empty arrays are false; all other values are true.
- `{{#each users}}{{@index}}: {{this.name}} / {{title}}{{else}}none{{/each}}`
  iterates arrays. Non-arrays and empty arrays select the optional else branch.
- `{{! comment }}` emits nothing. All text outside tags is preserved exactly.

Within a loop, `this` refers to the current item and `@index` to its zero-based
index. Normal paths try the current item, then the root if the path is absent.
An explicitly present null or undefined value does not fall back. Nested loops
use the innermost item and restore the outer context afterward. An each else
branch retains the surrounding context. Outside loops, `this` refers to the root.

Paths use dot-separated identifiers or numeric array indices (e.g. `users.0.name`);
only own properties are read. Expressions and parent-context syntax are not supported.
Missing and null values render as empty text. Scalar values stringify normally;
objects (including arrays) and functions throw on interpolation. Syntax and
non-scalar errors include a line and column. Templates never execute JavaScript.
