# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes interpolated values, while `{{{path}}}` leaves them
unchanged. The renderer also supports nested `if` and `each` blocks, `else`,
comments, `this`, and `@index`:

```handlebars
{{#each users}}
  {{@index}}: {{name}}
{{else}}
  No users
{{/each}}
```

Run the CLI with a UTF-8 template and a JSON data file:

```sh
bun run src/cli.ts template.txt data.json
```

Successful output contains only the rendered text. Syntax, file, JSON, and
rendering errors are written to stderr and result in a non-zero exit code.

Run the self-tests with `bun test`.
