# Mini Template

A dependency-free TypeScript template renderer for Bun.

## Usage

```sh
bun run src/cli.ts template.txt data.json
```

The command writes rendered text to stdout. Errors are written to stderr with a non-zero exit code.

```ts
import { render } from "./src/engine.ts";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

## Template syntax

- `{{path.to.value}}`: HTML-escaped interpolation.
- `{{{path.to.value}}}`: unescaped interpolation.
- `{{#if path}}...{{else}}...{{/if}}`: conditional block.
- `{{#each path}}...{{else}}...{{/each}}`: array loop; use `{{this}}` and `{{@index}}` inside.
- `{{! comment }}`: comment.

Run the self-tests with `bun test.ts`.
