# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes interpolated values, while `{{{path}}}` emits raw text. The five characters `& < > " '` are escaped. Missing and nullish values emit an empty string; objects, functions, and other non-scalar values cause a clear error.

Conditionals and array iteration support nesting and optional `else` branches:

```handlebars
{{#if signedIn}}Welcome, {{name}}{{else}}Please sign in{{/if}}
{{#each items}}{{@index}}: {{this.name}}{{else}}No items{{/each}}
```

Within `each`, `this` is the current item and `@index` is its zero-based index. Ordinary paths first inspect the current item, then fall back to the root data object. `{{! comments }}` emit nothing. All text and whitespace outside tags is preserved.

Run the CLI with a template and a JSON data file; rendered text is the only stdout output:

```sh
bun run src/cli.ts template.txt data.json
```

Run the self-tests with `bun test`.
