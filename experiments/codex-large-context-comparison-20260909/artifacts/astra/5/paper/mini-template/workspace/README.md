# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from './src/engine';
render('Hello, {{name}}!', { name: '<Ada>' }); // Hello, &lt;Ada&gt;!
```

```sh
bun run src/cli.ts template.txt data.json
bun test
```

The CLI reads UTF-8 template and JSON files, writes exactly the rendered text to
stdout, and reports errors on stderr with a nonzero exit status.

- `{{path.to.value}}` escapes `& < > " '`. Triple braces insert raw text.
- `{{#if path}}yes{{else}}no{{/if}}` supports nested blocks. Empty strings,
  zero, false, null, undefined, and empty arrays are false.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates
  arrays. Non-arrays use the optional else branch too.
- In a loop, normal paths resolve against the current item, then the root if
  the path is absent. Explicit `this` paths never fall back. Nested loops use
  the innermost item and index; there is no implicit parent-item lookup.
- `{{! comment }}` emits nothing. Whitespace outside tags is preserved.

Paths use dot-separated own properties, including numeric array indices.
Missing and null values interpolate as empty strings. Other scalar values use
JavaScript string conversion. Objects, arrays, and functions cannot be
interpolated and produce errors. Malformed structure and non-scalar
interpolations report a one-based line and column. Templates are parsed fully,
including inactive branches. No JavaScript expressions are evaluated.
