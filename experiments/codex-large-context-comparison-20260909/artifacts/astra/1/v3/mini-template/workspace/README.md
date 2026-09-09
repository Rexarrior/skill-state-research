# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello {{name}}!", { name: "<Ada>" }); // Hello &lt;Ada&gt;!
```

Run the CLI with `bun run src/cli.ts TEMPLATE_FILE DATA.json`. It reads UTF-8
files and writes the rendered text without an added newline. Errors go to stderr
with a nonzero exit status. Run the self-tests with `bun test`.

- `{{path.to.value}}` escapes `& < > " '`. `{{{path.to.value}}}` emits raw text.
- `{{#if path}}yes{{else}}no{{/if}}` supports nested blocks. Empty strings,
  zero, false, null, undefined, NaN, and empty arrays are false.
- `{{#each path}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays; non-arrays and empty arrays use the optional `else` branch.
- In loops, `this` is the current item and `@index` is its zero-based index.
  Normal paths first try the current item, then the root if missing. An existing
  null or undefined property does not trigger fallback. Nested loops restore the
  outer context when they end; there is no implicit parent-item lookup.
- Outside loops, `this` refers to the root and `@index` is missing.
- Paths use dot-separated own properties, including numeric array indexes.
  Inherited properties are not accessible. Keys containing whitespace, dots,
  braces, or tag control characters are not supported.
- `{{! comment }}` emits nothing. Other whitespace is preserved exactly.

Missing and null values interpolate as empty strings. Strings, numbers, booleans,
bigints, and symbols render as text. Objects, arrays, and functions cannot be
interpolated and cause a clear error. Syntax errors include line and column
numbers, even in branches that would not execute. Data and templates are never
executed as code.
