# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Sam & Jo" }); // Hello, Sam &amp; Jo!
```

```sh
bun run src/cli.ts template.txt data.json
bun test
```

The CLI reads UTF-8 files and writes the exact rendered text without adding a newline. Errors go to stderr with a nonzero exit status.

- `{{path.to.value}}` escapes `& < > " '`. Triple braces insert raw text.
- `{{#if path}}yes{{else}}no{{/if}}` supports nested blocks. Empty strings, zero, false, null, undefined, NaN, and empty arrays are false.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates arrays. Non-arrays use the optional `else` branch.
- Inside loops, `this` refers to the current item and `@index` to its zero-based index. Normal paths first look in the current item, then in the root data if the result is undefined. Explicit `this.*` paths never fall back. Nested loops restore the surrounding context when they end; an empty loop's `else` uses the surrounding context.
- Dot paths support numeric array indices (such as `items.0.name`) and read only own properties. There are no expressions, calls, or bracket notation. Outside a loop, `this` is the root data and `@index` is missing.
- `{{! comment }}` emits nothing. Whitespace outside tags is preserved.

Missing and null interpolation values produce empty text. Strings, numbers, booleans, and bigints render as text; arrays, objects, functions, and symbols throw a descriptive error. Malformed templates are rejected even in unused branches, with one-based line and column positions. Raw interpolation bypasses HTML escaping, so use it only for trusted content. No `eval`, generated functions, or third-party packages are used.
