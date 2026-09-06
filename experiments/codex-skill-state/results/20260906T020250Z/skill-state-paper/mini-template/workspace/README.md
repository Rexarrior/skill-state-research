# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada & Co" } });
// Hello, Ada &amp; Co!
```

Run it from the command line with a UTF-8 template and JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

The language supports escaped `{{path}}` and raw `{{{path}}}` interpolation,
comments (`{{! ... }}`), nested `if`/`else` blocks, and nested `each`/`else`
blocks. Within `each`, use `{{this}}`, `{{this.field}}`, and `{{@index}}`;
ordinary paths first inspect the current item and then fall back to root data.
Missing values produce no text. Interpolating an object, array, function, or
symbol is an error.

Run the self-tests with:

```sh
bun test
```
