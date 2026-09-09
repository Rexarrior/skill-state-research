# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from './src/engine';
render('Hello {{name}}!', { name: '<Ada>' }); // Hello &lt;Ada&gt;!
```

```sh
bun run src/cli.ts template.txt data.json
bun test
```

The CLI reads UTF-8 files, prints the exact rendered text, and reports errors
on stderr with a nonzero exit status.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` inserts raw text.
- `{{#if path}}yes{{else}}no{{/if}}` selects a branch. Empty strings,
  zero, false, null, undefined, and empty arrays are false; all other values are true.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}`
  iterates arrays. Non-arrays and empty arrays select the optional else branch.
- Blocks can nest. `this` and `@index` refer to the innermost loop; ordinary
  dot paths try the current item, then the root if the full path is absent.
  An explicitly present null or undefined value does not fall back.
- `{{! comment }}` emits nothing. Whitespace outside tags is unchanged.

Paths traverse own properties only, including numeric array indices. There
are no expressions, function calls, or prototype-property lookups. Outside
loops, `this` is the root and `@index` is missing. Missing/null values produce
empty text. Objects, arrays, and functions cannot be interpolated as scalar
text and throw an error. Syntax and non-scalar errors include line and column.
