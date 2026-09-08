# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada & friends" });
// Hello, Ada &amp; friends!
```

Run the CLI with `bun run src/cli.ts TEMPLATE_FILE DATA.json`. Both files are
read as UTF-8. Successful output is exactly the rendered text, without an added
newline. Errors go to stderr and set a non-zero exit status.

- `{{user.name}}` escapes `& < > " '`; `{{{user.name}}}` inserts raw text.
- Missing values and null render as empty text. Strings, numbers, booleans,
  and bigints render as text; objects (including arrays), functions, and symbols
  cause an error when interpolated.
- `{{#if path}}yes{{else}}no{{/if}}` uses JavaScript truthiness, except empty
  arrays are also false. Blocks can nest; `else` is optional.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}Empty{{/each}}` iterates
  arrays. Empty arrays and non-arrays use the `else` branch.
- Within a loop, normal dotted paths look first on the current item and fall
  back to the root if the path is missing. Explicit `this` paths never fall back.
  Nested loops use their own item and index and restore the outer context afterward.
  An empty loop's `else` keeps the surrounding context. Outside loops, `this`
  refers to the root and `@index` is missing.
- Paths access only own properties. Numeric segments can index arrays;
  expressions, parent paths, and bracket notation are not supported.
- `{{! comment }}` emits nothing. All text outside tags is preserved exactly.

The entire template is checked before rendering. Invalid blocks, closing tags,
duplicate or misplaced `else`, invalid paths, and unclosed tags report a
one-based line and column. Interpolation errors also identify their location.

Run all renderer and CLI self-tests with `bun test`. No install step is needed.
