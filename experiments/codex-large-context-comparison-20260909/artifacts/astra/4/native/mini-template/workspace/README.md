# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
// Hello, Ada!
```

Run the CLI with two UTF-8 files:

```sh
bun run src/cli.ts template.txt data.json
bun test
```

The CLI writes exactly the rendered text to stdout, without an added newline.
Errors go to stderr with a non-zero exit status. No package installation is needed.

Supported syntax:

- `{{user.name}}` escapes `& < > " '`; `{{{user.name}}}` inserts raw text.
- `{{#if user}}Hello{{else}}Guest{{/if}}` supports nested blocks. Empty strings,
  zero, false, null, undefined, NaN, and empty arrays are false.
- `{{#each users}}{{@index}}: {{this.name}}{{else}}No users{{/each}}` iterates
  arrays. Empty arrays and non-arrays select the optional `else` branch.
- `{{! comment }}` emits nothing. All text outside tags is preserved exactly.

Paths use dot-separated own-property names (including numeric array indices).
Inside a loop, ordinary paths first look in the current item, falling back to
the root when the complete path is absent. An existing null or undefined value
does not fall back. `this` explicitly selects the current item, and `@index`
selects the innermost loop index. Nested loops restore the outer context when
they finish. Outside loops, `this` is the root and `@index` is missing.

Missing and null interpolation values produce empty text. Other primitive
values become strings; objects, arrays, and functions raise an error.
Structural errors and invalid scalar interpolations include a one-based line
and column. The entire template is parsed before rendering, so malformed blocks
are rejected even inside an inactive branch. Templates cannot execute code.
