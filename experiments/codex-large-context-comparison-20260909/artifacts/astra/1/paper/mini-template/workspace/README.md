# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from './src/engine';
render('Hello, {{name}}!', { name: '<Ada>' }); // Hello, &lt;Ada&gt;!
```

Run the CLI with `bun run src/cli.ts TEMPLATE_FILE DATA.json`. It reads UTF-8
files and writes rendered text without an added newline. Errors go to stderr
with a non-zero exit status. Run tests with `bun test`.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if path}}yes{{else}}no{{/if}}` supports nested blocks. Empty strings,
  zero, false, null, missing values, and empty arrays are false.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` loops over
  arrays; missing, empty, or non-array values use the optional else branch.
- Within loops, normal paths first look in the current item, then the root.
  Explicit `this` refers to the current item (the root outside loops).
  Nested loops have their own item and index; exiting restores the outer context.
  An each block's else branch retains the surrounding context.
- `{{! comment }}` emits nothing. Text whitespace is preserved exactly.

Paths use dots and own properties only. Missing and null values interpolate as
empty text. Scalars are converted to strings; arrays, objects, and functions
produce errors in interpolations. An existing null or undefined item property
shadows the root property. Syntax errors and non-scalar interpolation errors
include a one-based line and column. All branches are parsed before rendering.
No expressions, code evaluation, or third-party packages are used.
