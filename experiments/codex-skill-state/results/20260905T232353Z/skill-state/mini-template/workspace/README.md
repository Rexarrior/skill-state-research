# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada & Lin" } });
// Hello, Ada &amp; Lin!
```

Supported tags are escaped `{{path}}` and raw `{{{path}}}` interpolation,
`{{#if path}}...{{else}}...{{/if}}`, array iteration with
`{{#each path}}...{{else}}...{{/each}}`, and `{{! comments }}`. Within an
`each` block, `{{this}}` and `{{@index}}` refer to the current item and index.
Blocks can be nested and whitespace outside tags is unchanged.

Run the CLI with a template and a JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

It writes only rendered text to stdout. Diagnostics go to stderr with a
non-zero exit status.

Run the self-tests:

```sh
bun test
```
