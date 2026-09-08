# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from './src/engine';
render('Hello {{name}}!', { name: '<Ada>' }); // Hello &lt;Ada&gt;!
```

Run the CLI with `bun run src/cli.ts template.txt data.json`. It reads UTF-8
files and writes the result without adding a newline. Errors go to stderr with
a nonzero exit status. Run self-tests with `bun test`.

- `{{path.to.value}}` escapes `& < > " '`; `{{{path.to.value}}}` emits raw text.
- `{{#if path}}yes{{else}}no{{/if}}` supports nesting. Empty strings, zero,
  false, null, undefined, and empty arrays are false. Objects are true.
- `{{#each items}}{{@index}}: {{this}}{{else}}empty{{/each}}` iterates arrays.
  Empty arrays and non-arrays select the optional `else` branch.
- Within loops, `this` is the current item, `this.name` accesses an item property,
  and `@index` is the innermost loop index. Ordinary paths check the current item,
  then the root if the path is absent. Explicit null or undefined values do not
  trigger fallback. Nested loops restore the outer context when they finish.
  Outside loops, `this` is the root and `@index` is missing.
- `{{! comment }}` emits nothing. Text outside tags is preserved exactly.

Paths use dot-separated own properties (including numeric array indices).
Missing and null values interpolate as empty text. Objects, arrays, and functions
cannot be interpolated and produce errors. Tags are case-sensitive; expressions
are not evaluated. Malformed structure is rejected even in inactive branches,
with one-based line and column locations. Raw interpolation performs no escaping;
use it only when unescaped output is intended.
