# Mini Template

Dependency-free TypeScript template rendering for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes output; `{{{path}}}` does not. Use `{{#if path}}…{{else}}…{{/if}}` and `{{#each path}}…{{else}}…{{/each}}`; loops expose `{{this}}` and `{{@index}}`, while ordinary paths resolve from the root data object. Comments use `{{! text }}`.

Run the tests with `bun test`. Render files with:

```sh
bun run src/cli.ts TEMPLATE_FILE DATA.json
```

The CLI writes only rendered content to standard output; errors are written to standard error.
