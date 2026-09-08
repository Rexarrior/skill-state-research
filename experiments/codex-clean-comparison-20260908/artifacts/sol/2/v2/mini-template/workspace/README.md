# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

`{{path}}` HTML-escapes values and `{{{path}}}` leaves them unescaped. The renderer also supports nested `if` and `each` blocks, optional `else` branches, `{{this}}`, `{{@index}}`, comments, and root-value fallback within loops.

```handlebars
{{#each users}}
  {{@index}}: {{name}}
{{else}}
  No users
{{/each}}
```

Run it from the command line with UTF-8 template and JSON files:

```sh
bun run src/cli.ts template.txt data.json
```

Rendered text is written to stdout. Usage, file, JSON, template, and value errors are written to stderr with a non-zero exit status.

Run the self-tests with `bun test`.
