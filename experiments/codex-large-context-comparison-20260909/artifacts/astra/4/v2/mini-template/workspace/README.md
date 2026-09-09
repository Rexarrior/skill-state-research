# Mini Template

A dependency-free TypeScript template renderer for Bun. No installation step is needed.

```ts
import { render } from "./src/engine";
render("Hello, {{name}}!", { name: "<Ada>" }); // Hello, &lt;Ada&gt;!
```

```sh
bun run src/cli.ts template.html data.json
bun test
```

The CLI reads UTF-8 files, writes the exact rendered text to stdout without an added newline, and reports errors on stderr with a nonzero exit code.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if enabled}}yes{{else}}no{{/if}}` supports nested blocks. Empty strings, zero, false, null, undefined, and empty arrays are false (as is NaN); other values are true.
- `{{#each users}}{{@index}}: {{this.name}} / {{site}}{{else}}No users{{/each}}` iterates arrays. Empty arrays and non-array values take the optional `else` branch.
- Inside loops, `this` is the current item and `@index` is its zero-based index. Ordinary dotted paths first look in the current item, then in the root data if the full path is absent. Explicit null or undefined values do not trigger fallback. Nested loops keep their own item/index and restore the outer context afterward; there is no implicit parent lookup. Outside loops, `this` is the root and `@index` is missing.
- `{{! comment }}` emits nothing. Whitespace outside tags is preserved exactly; whitespace around tag expressions is ignored.

Paths use dot-separated property names (including numeric array indices), access only own properties, and do not evaluate expressions. Missing or null values insert empty text. Strings, numbers, booleans, and bigints render as text; arrays, objects, functions, and symbols throw when interpolated. Raw insertion still requires scalar text and should be used only for trusted markup.

The entire template is parsed before rendering, including inactive branches. Invalid paths, unknown blocks, unmatched/unclosed tags, and misplaced or duplicate `else` tags report one-based line and column positions.
