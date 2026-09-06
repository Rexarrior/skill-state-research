# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
// Hello, Ada!
```

`{{path}}` HTML-escapes text; `{{{path}}}` leaves it raw. Use `{{#if path}}…{{else}}…{{/if}}` for conditional content and `{{#each path}}…{{else}}…{{/each}}` for arrays. In loops, `{{this}}` and `{{@index}}` refer to the current item and position; other paths fall back to the root data object. Comments use `{{! comment }}`.

Run the CLI with UTF-8 template and JSON data files:

```sh
bun run src/cli.ts TEMPLATE_FILE DATA.json
```

Run self-tests:

```sh
bun test
```
