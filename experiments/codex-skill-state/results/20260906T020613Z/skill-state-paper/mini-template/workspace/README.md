# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Run it from the command line with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

## Syntax

- `{{path.to.value}}` inserts HTML-escaped scalar text.
- `{{{path.to.value}}}` inserts unescaped scalar text.
- `{{#if path}}...{{else}}...{{/if}}` conditionally renders a branch.
- `{{#each path}}...{{else}}...{{/each}}` iterates an array. Use `{{this}}`, `{{this.property}}`, and `{{@index}}` for the current item; other paths refer to the root data.
- `{{! comment }}` renders nothing.

Missing values render as empty strings. Interpolating objects or functions and malformed block structure produce descriptive errors. Empty strings, zero, false, null, undefined, and empty arrays are false in conditionals.

## Development

```sh
bun test
bun run typecheck
```
