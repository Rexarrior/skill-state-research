# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
// Hello, Ada!
```

`{{path}}` HTML-escapes values; `{{{path}}}` leaves them unchanged. It supports
comments (`{{! note }}`), nested `if` blocks, and array `each` blocks. In an
`each`, `{{this}}` and `{{@index}}` refer to the current item and its index;
other paths are resolved from the root data object.

Run a template from files:

```sh
bun run src/cli.ts TEMPLATE_FILE DATA.json
```

Run the self-tests:

```sh
bun test
```
