# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";
render("Hello, {{name}}!", { name: "Ada & friends" });
// Hello, Ada &amp; friends!
```

Run the CLI with two UTF-8 input files:

```sh
bun run src/cli.ts template.html data.json
bun test
```

The CLI writes only rendered text to stdout, without an added newline. Errors go
to stderr with a nonzero exit status.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` emits raw text.
- `{{#if value}}yes{{else}}no{{/if}}` branches on truthiness. Empty arrays,
  empty strings, zero, false, null, undefined, and missing values are false.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays. Missing, empty, or non-array values select the optional else branch.
- `{{! comment }}` emits nothing. Whitespace outside tags is preserved.

Blocks can nest. Within loops, `this` is the current item and `@index` is its
zero-based index. Normal paths first look in the current item, then fall back to
the root when the full path is missing. An explicitly present null or undefined
value does not fall back. `this.name` never falls back. Nested loops use their own
item and index; leaving a loop restores the enclosing context. At the top level,
`this` is the input data and `@index` is missing. Only own properties are read.
Paths use dot-separated keys (including numeric array indices); expressions,
helpers, and bracket notation are not supported.

Missing and nullish interpolation values produce empty text. Strings, numbers,
booleans, and bigints render as text; arrays, objects, functions, and symbols
raise a clear error. Structural errors are checked even in inactive branches.
Template errors include a one-based line and column. Raw interpolation does not
escape HTML, so use it only when the value is appropriate for the output.
