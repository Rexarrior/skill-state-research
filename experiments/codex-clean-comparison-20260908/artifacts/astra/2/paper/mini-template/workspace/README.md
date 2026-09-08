# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";
render("Hello, {{name}}!", { name: "<Ada>" }); // Hello, &lt;Ada&gt;!
```

Run `bun run src/cli.ts TEMPLATE_FILE DATA.json`. Files use UTF-8; stdout contains
only the rendered text, with no added newline. Errors go to stderr with a nonzero
exit status. Run the self-tests with `bun test`.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- Missing values and null render as empty text. Strings, numbers, booleans,
  bigints, and symbols render as text; arrays, objects, and functions throw.
- `{{#if path}}yes{{else}}no{{/if}}` uses JavaScript truthiness, except empty
  arrays are false. Blocks can nest; `else` is optional.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays. Empty arrays, missing values, and non-arrays select the else branch.
  `this` refers to the current item (`this` outside loops refers to root data).
  Normal dotted paths try the current item, then the root if the full path is
  absent. An existing null or undefined value does not trigger fallback.
  Nested loops use their own item/index and restore the outer context afterward;
  they do not search parent items. An empty loop's else retains its outer context.
- `{{! comment }}` emits nothing. Whitespace outside tags is preserved exactly.

Paths use dot-separated property names (including numeric array indices), with
no expressions or bracket syntax. Only own properties are accessed. Syntax errors
and non-scalar interpolation errors report a one-based line and column. Templates
are fully parsed before rendering, so invalid syntax in skipped branches fails too.
