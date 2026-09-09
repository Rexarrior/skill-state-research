# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello {{name}}!", { name: "Ada & friends" });
// Hello Ada &amp; friends!
```

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
bun test
```

The CLI writes the exact rendered text to stdout, without adding a newline.
Errors go to stderr with a nonzero exit status.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if path}}yes{{else}}no{{/if}}` supports nested blocks. Empty strings,
  zero, false, null, undefined, and empty arrays are false.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays. Missing, empty, or non-array values select the optional else branch.
- Within loops, normal paths look in the current item first, then the root
  when the path is absent. Explicit null or undefined values do not fall back.
  `this` and `@index` refer to the innermost loop; leaving it restores the outer
  context. Outside loops, `this` refers to the root and `@index` is missing.
- `{{! comment }}` emits nothing. Whitespace outside tags is preserved exactly.

Paths use dot-separated, whitespace-free property names (including numeric array
indices) and access only own properties. Missing and null values produce empty
text; strings, numbers, booleans, and bigints render as text. Arrays, objects,
functions, and symbols raise an error when interpolated. Blocks and paths are
validated even in branches that are not rendered. Template errors include a
one-based line and column. The renderer never evaluates template code.
