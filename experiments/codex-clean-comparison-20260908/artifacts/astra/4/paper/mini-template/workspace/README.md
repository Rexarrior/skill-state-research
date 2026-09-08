# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from './src/engine';
render('Hello, {{name}}!', { name: '<Ada>' }); // Hello, &lt;Ada&gt;!
```

Run `bun run src/cli.ts TEMPLATE_FILE DATA.json` to render UTF-8 files. Stdout
contains exactly the result (no added newline). Errors go to stderr with a
nonzero exit code. Run self-tests with `bun test`.

- `{{path.to.value}}` escapes `& < > " '`; `{{{path.to.value}}}` emits raw text.
- Missing, undefined, and null values emit an empty string. Objects, arrays,
  and functions cannot be interpolated as scalar text and throw an error.
- `{{#if path}}yes{{else}}no{{/if}}` supports nesting. Empty strings, zero,
  false, null, undefined, and empty arrays are false (as is NaN).
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays; missing, empty, and non-array values use the optional else branch.
- Inside loops, ordinary paths first search the current item, then the root
  if missing. An explicitly present undefined or null value does not fall back.
  `this` always refers to the current item; `@index` to the innermost loop.
  Else branches retain their surrounding context. Outside loops, `this` is
  the root and `@index` is missing. Only own properties are accessible.
- `{{! comment }}` emits nothing. All whitespace outside tags is preserved.

Paths are dot-separated property names, without whitespace. Blocks and else
branches may nest. Invalid structure and non-scalar interpolations report a
1-based line and column. Templates never execute code. Raw interpolation
should only be used when escaping is unnecessary for the destination.
