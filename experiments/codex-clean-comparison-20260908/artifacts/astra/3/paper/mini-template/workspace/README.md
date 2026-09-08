# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from './src/engine';
render('Hello {{name}}!', { name: '<Ada>' }); // Hello &lt;Ada&gt;!
```

Run `bun run src/cli.ts TEMPLATE_FILE DATA.json`. Both files are read as UTF-8.
Only the rendered text is written to stdout, without an added newline. Errors
are written to stderr with a nonzero exit status. Run tests with `bun test`.

- `{{user.name}}` escapes `& < > " '`; `{{{user.name}}}` inserts raw text.
- Missing, null, and undefined values insert an empty string. Objects, arrays,
  and functions cannot be interpolated as scalar text and throw an error.
- `{{#if path}}yes{{else}}no{{/if}}` tests truthiness. Empty arrays are false,
  as are empty strings, zero, false, null, undefined, and NaN.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays; missing or non-array values use the optional else branch.
- Within loops, ordinary paths look in the current item first, then fall back
  to the root if the full path is absent. Explicit null or undefined values
  do not fall back. `this` always means the current item (the root outside
  loops). Nested loops use their own item and index and restore the outer
  context afterward. `if` and `else` preserve the current context.
- `{{! comment }}` emits nothing. Blocks nest and whitespace outside tags is
  preserved exactly. Paths use dots and only access own properties.

Malformed tags and block structures throw errors with a 1-based line and
column. The whole template is parsed even when a branch will not render.
