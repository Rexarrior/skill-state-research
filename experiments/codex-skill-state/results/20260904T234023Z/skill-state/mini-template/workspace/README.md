# Mini Template

A dependency-free TypeScript template renderer for Bun.

## Use as a library

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes text; `{{{path}}}` does not. Blocks support
`{{#if path}}…{{else}}…{{/if}}` and array iteration with
`{{#each path}}{{this}} {{@index}}{{else}}…{{/each}}`. Comments use `{{! ... }}`.
Paths inside loops resolve against the root data object, while `this` and
`@index` address the current iteration. Missing values are empty; objects and
functions cannot be interpolated.

## CLI

```sh
bun run src/cli.ts template.txt data.json
```

The rendered result is written to stdout. Input, JSON, and template errors are
written to stderr with a non-zero exit status.

## Tests

```sh
bun test
```
