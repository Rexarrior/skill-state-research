# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}`, raw `{{{path}}}`, comments
`{{! ... }}`, conditionals `{{#if path}}...{{else}}...{{/if}}`, and array
loops `{{#each path}}...{{else}}...{{/each}}`. Loops expose `this` and
`@index`; ordinary paths check the current item and then the root data.

Run the CLI with two UTF-8 files:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is the only successful stdout output. Errors are written to
stderr with a non-zero exit status.

Run the self-tests with:

```sh
bun test
```
