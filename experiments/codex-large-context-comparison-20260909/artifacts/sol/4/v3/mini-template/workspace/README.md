# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes values, while `{{{path}}}` inserts raw scalar text. The language also supports `if`, `each` (with `this` and `@index`), `else`, nested blocks, dotted paths, and `{{! comments }}`. Missing values become empty strings. Objects and functions cannot be interpolated.

Run the command-line renderer with two UTF-8 files:

```sh
bun run src/cli.ts template.txt data.json
```

The rendered text is the only stdout output. Usage, file, JSON, template, and rendering errors are written to stderr with a non-zero exit status.

Run the test suite with:

```sh
bun test
```
