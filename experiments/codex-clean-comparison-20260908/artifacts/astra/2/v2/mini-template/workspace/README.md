# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";
render("Hello {{name}}!", { name: "Sam & Jo" }); // Hello Sam &amp; Jo!
```

Run `bun run src/cli.ts TEMPLATE_FILE DATA.json`. Files are UTF-8; stdout
contains only rendered text, with no added newline. Errors go to stderr with
a non-zero exit code. Run the self-tests with `bun test`.

- `{{user.name}}` escapes `& < > " '`; `{{{user.name}}}` inserts raw text.
- `{{#if active}}yes{{else}}no{{/if}}` supports nested blocks. Empty strings,
  zero, false, null, undefined, and empty arrays are false; other values are true.
- `{{#each users}}{{@index}}: {{this.name}} ({{site}}){{else}}No users{{/each}}`
  iterates arrays. Empty arrays and non-arrays use the optional else branch.
  `this` and `@index` refer to the innermost loop. Normal paths try the current
  item first, then the root if the path is absent. An existing null or undefined
  value does not fall back. Inner loops do not search outer items. Outside loops,
  `this` refers to the root and `@index` is missing.
- `{{! comment }}` emits nothing. All text outside tags is preserved.

Paths use dot-separated own properties, including numeric array indices;
prototype properties are not exposed. Tags may contain surrounding whitespace.
Missing and null values render as empty text. Strings, numbers, booleans, and
bigints render as scalar text; arrays, objects, functions, and symbols produce
an error when interpolated. Templates support no expressions or code execution.
Structural errors and invalid interpolations report a line and column (1-based).
