# Mini Template

A dependency-free TypeScript template renderer for Bun.

## Use as a library

```ts
import { render } from "./src/engine";

render("Hello {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes scalar values; `{{{path}}}` leaves them untouched. Use
`{{#if path}}...{{else}}...{{/if}}` for conditionals and
`{{#each path}}...{{else}}...{{/each}}` for arrays. Loop bodies expose
`{{this}}` and `{{@index}}`, while ordinary paths continue to resolve from the
root data object. Comments use `{{! comment }}`.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

The command reads UTF-8 inputs, writes the rendered result to stdout, and sends
usage, file, JSON, and template errors to stderr with a non-zero exit code.

## Tests

```sh
bun test
```
