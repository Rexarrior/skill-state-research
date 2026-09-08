# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{name}}!", { name: "Ada & friends" });
// Hello, Ada &amp; friends!
```

Run `bun run src/cli.ts TEMPLATE_FILE DATA.json`. Files are read as UTF-8;
stdout contains exactly the rendered text. Errors go to stderr with a nonzero
exit status. Run all self-tests with `bun test`.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- Missing and null values produce empty text. Objects, arrays, and functions
  cannot be interpolated and throw an error.
- `{{#if path}}yes{{else}}no{{/if}}` selects a branch. Empty strings, zero,
  false, null, undefined, and empty arrays are false; other values are true.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays. Missing, non-array, and empty inputs select the optional else branch.
- Inside loops, ordinary paths search the current item then the root object
  when the full path is absent. An explicitly present null or undefined value
  takes precedence. `this` explicitly selects the current item (the root outside
  loops). `@index` refers to the innermost loop. Nested loops restore the outer
  context afterward; an each else branch retains its surrounding context.
- Paths use dot-separated own properties only; inherited properties are ignored.
- `{{! comment }}` emits nothing. Blocks nest and whitespace outside tags is
  preserved exactly. Invalid structure and non-scalar values report line and
  column positions (one-based).

The renderer parses the entire template before rendering and uses no dynamic
code execution or third-party packages. Raw insertion deliberately skips HTML
escaping.
