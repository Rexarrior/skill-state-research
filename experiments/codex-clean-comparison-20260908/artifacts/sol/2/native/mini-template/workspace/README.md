# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax:

- `{{path}}` for HTML-escaped interpolation and `{{{path}}}` for raw interpolation
- `{{#if path}}...{{else}}...{{/if}}` for conditionals
- `{{#each path}}...{{else}}...{{/each}}` for arrays, with `{{this}}` and `{{@index}}`
- `{{! comments }}`

Inside loops, paths first resolve against the current item and then the root data. Missing values produce an empty string. Interpolating an object or function throws a `TemplateError`.

Run the CLI with a template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Run the self-tests with `bun test`.
