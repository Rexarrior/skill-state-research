# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";
render("Hello, {{name}}!", { name: "Ada & friends" });
// Hello, Ada &amp; friends!
```

Run `bun run src/cli.ts TEMPLATE_FILE DATA.json` to render UTF-8 files. Output is
written exactly to stdout without an added newline. Errors go to stderr with a
non-zero exit status. Run the self-tests with `bun test`.

- `{{user.name}}` inserts text with `& < > " '` HTML-escaped.
- `{{{user.name}}}` inserts raw text.
- `{{#if user}}yes{{else}}no{{/if}}` chooses a branch. Empty strings, zero,
  false, null, undefined, and empty arrays are false. Objects are true.
- `{{#each users}}{{@index}}: {{this.name}}{{else}}Nobody{{/each}}` iterates
  arrays. Empty arrays and non-arrays use the optional `else` branch.
- `{{! comment }}` emits nothing. All text outside tags is preserved.

Blocks can nest. Inside a loop, ordinary dotted paths first check the current
item, then fall back to the root if the path is missing. An existing null or
undefined value does not fall back. `this` explicitly selects the current item
(the root outside loops); `@index` belongs to the innermost loop. After a nested
loop, the enclosing context is restored. Only own properties are read; numeric
segments such as `users.0.name` are supported. There are no expressions or helpers.

Missing values, null, and undefined interpolate as empty text. Other primitives
are converted to strings. Objects, arrays, and functions cannot be interpolated
and produce an error. Syntax and non-scalar interpolation errors include a
one-based line and column. Raw interpolation is intended for trusted content.
