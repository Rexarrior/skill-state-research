# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from './src/engine';
render('Hello {{name}}!', { name: '<Ada>' }); // Hello &lt;Ada&gt;!
```

Run the CLI with `bun run src/cli.ts TEMPLATE_FILE DATA.json`. It reads UTF-8
files and writes exactly the rendered text to stdout, without an added newline.
Errors go to stderr and produce a nonzero exit status.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if path}}yes{{else}}no{{/if}}` supports nesting. Empty strings, zero,
  false, null, undefined, and empty arrays are false.
- `{{#each items}}{{@index}}: {{this}}{{else}}empty{{/each}}` iterates arrays.
  Missing, empty, or non-array values select the optional else branch.
- Inside loops, `this` is the item, `this.name` explicitly selects its property,
  and `@index` is the current loop's zero-based index. Normal paths search the
  current item, then the root if the path is missing. An existing null or
  undefined property does not fall back. Nested loops restore the outer context
  after completion. Outside loops, `this` refers to the root.
- `{{! comment }}` emits nothing. Whitespace outside tags is unchanged.

Paths use dot-separated own properties; inherited properties are inaccessible.
Missing and null values interpolate as empty text. Strings, numbers, booleans,
and bigints render as scalar text; arrays, objects, functions, and symbols cause
an error when interpolated. Blocks are parsed before rendering; malformed
structure and nonscalar interpolation errors include a one-based line and column.
Raw interpolation is intended for trusted text because it bypasses HTML escaping.

Run the self-tests with `bun test`.
