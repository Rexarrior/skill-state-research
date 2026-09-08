# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Run it from the command line with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

The language supports escaped `{{path}}` and raw `{{{path}}}` interpolation,
`{{#if path}}...{{else}}...{{/if}}`, array iteration with
`{{#each path}}...{{else}}...{{/each}}`, `{{this}}`, `{{@index}}`, nested blocks,
and silent `{{! comments }}`. Missing values become empty strings. Interpolating
objects or functions is an error.

Run the self-tests with:

```sh
bun test
```
