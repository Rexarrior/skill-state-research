# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from './src/engine.ts';
render('Hello, {{name}}!', { name: '<Ada>' }); // Hello, &lt;Ada&gt;!
```

Run `bun run src/cli.ts TEMPLATE_FILE DATA.json` to read UTF-8 files and write
rendered text to stdout without adding a newline. Errors go to stderr with a
nonzero exit status. Run the self-tests with `bun test`.

- `{{path.to.value}}` escapes `& < > " '`. Triple braces insert raw text.
- `{{#if path}}yes{{else}}no{{/if}}` tests truthiness. Empty arrays are also
  false; empty strings, zero, false, null, and missing values are false.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays. Missing, empty, and non-array values select the optional else branch.
- Blocks nest, and `{{! comments }}` emit nothing. All text outside tags is
  preserved exactly; surrounding whitespace inside tags is ignored.

Paths traverse own properties only, with dot-separated segments (including array
indices). Within loops, normal paths first resolve against the current item and
fall back to the root if the full path is missing. An explicitly present null or
undefined value does not fall back. `this` and `this.path` explicitly select the
current item; outside loops they select the root. `@index` selects the innermost
loop index. Leaving a nested loop restores the outer item/index. There is no
implicit lookup in parent loop items.

Missing, null, and undefined interpolations produce empty text. Other scalar
values become strings; objects, arrays, and functions cannot be interpolated and
raise a clear error. Structural errors are detected even in inactive branches
and report a one-based line and column. Templates support property paths, not
expressions or JavaScript evaluation.
