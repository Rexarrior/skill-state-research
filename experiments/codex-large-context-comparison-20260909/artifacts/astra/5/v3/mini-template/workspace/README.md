# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";
render("Hello {{name}}!", { name: "Ada & friends" });
// Hello Ada &amp; friends!
```

Run the CLI with two UTF-8 files:

```sh
bun run src/cli.ts template.txt data.json
bun test
```

The CLI writes rendered text exactly (no added newline) to stdout. Errors go to stderr with a nonzero exit status.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if value}}yes{{else}}no{{/if}}` supports nesting. Empty strings, zero, false, null, undefined, missing values, and empty arrays are false.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates arrays. Non-arrays use the optional else branch.
- In loops, normal paths first resolve against the current item, then the root if the path is absent. An explicitly present null or undefined value does not fall back. `this` and `@index` refer to the innermost loop. Outside loops, `this` is the root and `@index` is missing. Nested loops restore the outer context when they end.
- Paths use dot-separated own properties only; inherited properties are unavailable.
- `{{! comment }}` emits nothing. All text outside tags retains its whitespace.

Missing and nullish interpolations are empty. Strings, numbers, booleans, and bigints render as text; objects, arrays, functions, and symbols throw clear errors. Template structure is validated even in branches that do not render. Syntax and scalar errors include a one-based line and column.
