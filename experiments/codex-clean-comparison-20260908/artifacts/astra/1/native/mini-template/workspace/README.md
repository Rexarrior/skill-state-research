# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada & Lin" } });
// Hello, Ada &amp; Lin!
```

Run the CLI with `bun run src/cli.ts TEMPLATE_FILE DATA.json`. It reads UTF-8
files and writes the exact rendered text without an added newline. Errors go to
stderr with a non-zero exit status. Run self-tests with `bun test`.

- `{{path.to.value}}` escapes `& < > " '`. Triple braces (`{{{path}}}`) insert raw text.
- Missing, null, and undefined interpolations produce empty text. Objects,
  arrays, and functions cannot be interpolated; they produce descriptive errors.
- `{{#if path}}yes{{else}}no{{/if}}` supports nesting. Empty arrays and JavaScript
  falsy values are false; other values are true. The `else` branch is optional.
- `{{#each items}}{{@index}}: {{this.name}}{{else}}empty{{/each}}` iterates arrays.
  Empty arrays and non-arrays use the optional `else` branch.
- In loops, ordinary paths look in the current item first, then the root if the
  path is absent. Explicit null or undefined values do not fall back. `this`
  always refers to the current item (the root outside loops); `@index` refers to
  the innermost loop. Nested loops restore the enclosing context when finished.
  An empty loop's `else` keeps the enclosing context.
- Paths use dot-separated own property names, including array indices. Prototype
  properties are not exposed. Expressions and parent-context syntax are not supported.
- `{{! comment }}` emits nothing. Tag contents are trimmed; surrounding whitespace
  is preserved exactly. Structural errors report one-based line and column numbers.

```text
{{#if users}}<ul>
{{#each users}}  <li>{{name}} — {{site.title}}</li>
{{/each}}</ul>{{else}}No users.{{/if}}
```

Pass JSON or plain data objects. Raw interpolation deliberately bypasses HTML
escaping, so use it only for content you trust.
