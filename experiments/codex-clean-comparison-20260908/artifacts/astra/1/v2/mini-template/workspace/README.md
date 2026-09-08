# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";
render("Hello {{name}}!", { name: "<Ada>" }); // Hello &lt;Ada&gt;!
```

Run the CLI with `bun run src/cli.ts TEMPLATE_FILE DATA.json`. Both files are
read as UTF-8. Success writes exactly the rendered text to stdout, with no
extra newline. Errors go to stderr and set a non-zero exit status.

- `{{path.to.value}}` escapes `& < > " '`. Triple braces insert raw text.
- `{{#if path}}yes{{else}}no{{/if}}` supports nested conditions. Empty strings,
  zero, false, null, undefined, and empty arrays are false; other values are true.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays. Non-arrays and empty arrays use the optional else branch.
- Inside loops, ordinary paths look on the current item first, then the root
  if the full path is absent. An explicitly present null/undefined value does
  not fall back. `this` and `this.path` always address the current item;
  `@index` addresses the innermost loop. Nested loops restore the outer context
  when they finish. An each else branch retains its enclosing context.
- `{{! comment }}` emits nothing. Text outside tags is preserved exactly.

Paths use dot-separated own properties (including numeric array indices);
prototype properties are inaccessible. Tag whitespace is ignored. There are
no expressions, helpers, or parent-context syntax. At top level `this` is the
input data and `@index` is missing. Missing/null/undefined interpolations emit
empty text. Strings, numbers, booleans, and bigints render as text; objects,
arrays, functions, and symbols raise errors. Syntax errors are checked even in
branches that do not render, and errors include a one-based line and column.
Raw interpolation should only be used for content you trust.

Run the self-tests with `bun test`. No package installation is needed.
