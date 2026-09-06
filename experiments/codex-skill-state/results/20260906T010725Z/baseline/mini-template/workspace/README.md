# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Double braces HTML-escape values; triple braces insert raw scalar values. The
language also supports comments, nested `if` blocks, and nested `each` blocks:

```handlebars
{{! a comment }}
{{#if signedIn}}
  {{#each users}}{{@index}}: {{this.name}}{{else}}No users{{/each}}
{{else}}
  Please sign in
{{/if}}
```

Inside `each`, `this` is the current item and `@index` is its zero-based index.
Normal paths are first read from the current item and fall back to the root data.
Missing values render as empty strings; interpolating objects or functions
throws an error.

Run the CLI with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered result is the only stdout output. Run tests with `bun test`.
