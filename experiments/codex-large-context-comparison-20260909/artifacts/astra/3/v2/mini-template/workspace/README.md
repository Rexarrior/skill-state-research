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

The CLI reads UTF-8 files and writes the exact rendered text, without an added newline. Errors go to stderr with a nonzero exit code.

- `{{user.name}}` escapes `& < > " '`; `{{{user.name}}}` inserts raw text.
- Missing values, null, and undefined render as empty text. Strings, numbers, booleans, and bigints render as text. Objects, arrays, functions, and symbols produce errors when interpolated.
- `{{#if path}}yes{{else}}no{{/if}}`: empty strings, zero, false, null, undefined, and empty arrays are false. Other values are true.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates arrays. Empty arrays, missing values, and non-arrays select the optional `else` branch.
- Within loops, `this` is the current item and `@index` is its zero-based index. Plain paths look in the current item first, then fall back to the root when the path is missing. An existing null or undefined property does not fall back. `this.name` accesses only the current item. Outside loops, `this` refers to the root.
- Nested loops use the innermost item/index and restore the enclosing context afterward. An empty loop's `else` retains the enclosing context.
- `{{! comment }}` emits nothing. Whitespace outside tags is preserved exactly; whitespace surrounding tag contents is ignored.

Paths are dot-separated, case-sensitive own-property names (including numeric array indices). Inherited properties are never resolved. Bracket syntax, expressions, and parent-context navigation are not supported. Blocks can nest; parsing validates even branches that will not render. Syntax and scalar-value errors report one-based line and column locations.
