# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";
render("Hello, {{name}}!", { name: "<Ada>" }); // Hello, &lt;Ada&gt;!
```

```sh
bun run src/cli.ts template.txt data.json
bun test
```

The CLI reads UTF-8 files, writes the exact rendered text to stdout, and reports errors to stderr with a nonzero exit code.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if value}}yes{{else}}no{{/if}}` supports nested blocks. Empty arrays and JavaScript falsy values are false.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates arrays. Missing values, non-arrays, and empty arrays use the optional `else` branch.
- Inside a loop, `this` is the current item and `@index` its zero-based index. Ordinary paths search the current item first, then the root if the full path is absent. Explicit `this` paths never fall back. Nested loops use their own item and index; the outer scope resumes afterward. At the top level, `this` is the root and `@index` is missing.
- `{{! comment }}` emits nothing. All text and whitespace outside tags are preserved.

Paths use dot-separated own properties (including numeric array indices); inherited properties are not exposed. There are no expressions or function calls. Missing and null values interpolate as empty strings. Strings, numbers, booleans, and bigints render as text; arrays, objects, functions, and symbols throw a clear error. Use loops for arrays. Structural errors include the tag's one-based line and column and are detected even in branches that would not render. HTML escaping is for text, not a URL, script, or CSS sanitizer.
