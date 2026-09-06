# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}`, raw `{{{path}}}`, comments
`{{! ... }}`, conditionals with optional `{{else}}`, and array iteration:

```handlebars
{{#each users}}
  {{@index}}: {{this.name}}
{{else}}
  No users
{{/each}}
```

Within a loop, `this` is the item and `@index` is its zero-based index. Ordinary
paths first inspect the current item and then fall back to the root data.

Run the CLI with two UTF-8 files:

```sh
bun run src/cli.ts template.txt data.json
```

It writes only rendered output to stdout. Errors are written to stderr and set a
non-zero exit status. Run the self-tests with `bun test`.
