# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada & friends" });
// Hello, Ada &amp; friends!
```

```sh
bun run src/cli.ts template.txt data.json
bun test
```

The CLI reads UTF-8 files, writes the result without an added newline, and reports errors to stderr with a non-zero exit code. No installation is needed.

- `{{path.to.value}}` escapes `& < > " '`. `{{{path.to.value}}}` outputs raw text.
- `{{#if path}}yes{{else}}no{{/if}}` supports nesting. Empty strings, zero, false, null, undefined, and empty arrays are false.
- `{{#each items}}{{@index}}: {{this}}{{else}}empty{{/each}}` iterates arrays; missing, empty, or non-array values use the optional else branch.
- In loops, `this` is the current item and `this.name` accesses its properties. Normal paths resolve against the current item, then the root if the path is absent. Present null or undefined values do not fall back. Nested loops use their own item and index and restore the outer context afterward. Outside loops, `this` refers to the root and `@index` is missing.
- Paths use dot-separated letters, digits, underscores, or dollar signs, including numeric array indices. Only own properties are read.
- `{{! comment }}` emits nothing. Whitespace outside tags is preserved exactly.

Missing and null values interpolate as empty text. Strings, numbers, booleans, and bigints are supported; arrays, objects, functions, and symbols throw when interpolated. Syntax errors and unsupported interpolation values report a one-based line and column. All syntax is validated, including branches that are not executed. Raw interpolation is intended for trusted text.
