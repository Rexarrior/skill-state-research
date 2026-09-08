# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from './src/engine';
render('Hello, {{name}}!', { name: '<Ada>' }); // Hello, &lt;Ada&gt;!
```

Run the CLI with `bun run src/cli.ts TEMPLATE_FILE DATA.json`. It reads UTF-8
files and writes the exact rendered text without an added newline. Errors are
reported on stderr with a nonzero exit status. Run tests with `bun test`.

- `{{path.to.value}}` escapes `& < > " '`. Triple braces insert raw text.
- `{{#if path}}yes{{else}}no{{/if}}` selects a branch. Empty arrays and
  JavaScript falsy values are false; other values are true.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}`
  iterates arrays. Missing, non-array, and empty values use the optional else branch.
- Blocks nest freely. `this` refers to the current loop item (or root outside
  loops), and `@index` refers to the innermost loop index. Normal paths search
  the current item first, then the root if missing. Explicit `this` paths never
  fall back. An existing null or undefined value does not trigger fallback.
- `{{! comment }}` emits nothing. All text outside tags is preserved.

Paths use dot-separated own properties, including numeric array indices;
prototype properties are not exposed. Missing/null values interpolate as empty
text. Other scalar primitives stringify; objects, arrays, and functions throw.
Malformed tags and block structures throw errors with line and column locations,
even in branches that would not render. There are no expressions or executable
template code.
