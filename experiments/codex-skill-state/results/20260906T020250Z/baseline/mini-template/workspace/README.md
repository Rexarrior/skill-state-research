# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported syntax:

- `{{path.to.value}}` for HTML-escaped interpolation and `{{{path}}}` for raw interpolation
- `{{#if path}}...{{else}}...{{/if}}` for conditionals
- `{{#each path}}...{{else}}...{{/each}}` for arrays; use `{{this}}` and `{{@index}}` in the loop
- `{{! comment }}` for comments

Run the CLI with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Run the self-tests:

```sh
bun test
```
