# Mini Template

A dependency-free TypeScript template renderer for Bun. No installation step is needed.

```ts
import { render } from './src/engine';
render('Hello {{name}}!', { name: '<Ada>' }); // Hello &lt;Ada&gt;!
```

```sh
bun run src/cli.ts template.html data.json
bun test
```

The CLI reads UTF-8 files, writes exactly the rendered text to stdout, and reports errors to stderr with a nonzero exit status.

- `{{user.name}}` escapes `& < > " '`. `{{{user.name}}}` emits raw text.
- `{{#if enabled}}yes{{else}}no{{/if}}` selects a branch. Empty strings, zero, false, null, undefined, and empty arrays are false; all other values are true.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates arrays; non-arrays take the empty branch.
- `{{! comment }}` emits nothing. All text outside tags is preserved exactly.

Blocks can nest. Within a loop, `this` is the current item and `@index` is its index. Ordinary dotted paths first resolve against the current item and then fall back to the root when the full path is absent. An existing null or undefined value does not trigger fallback. Explicit `this` paths never fall back. Nested loops restore the enclosing item and index when they finish; an empty loop's alternate branch retains the enclosing context. Outside loops, `this` is the root and `@index` is missing.

Paths use dots (including numeric array indexes), access only own properties, and do not support expressions or bracket notation. Missing and null values interpolate as empty text. Other scalar values stringify; arrays, objects, and functions raise a clear error. Malformed tags and block structure raise errors with one-based line and column locations, even in branches that are not rendered. Raw interpolation does not escape HTML; use it only when that is intended.
