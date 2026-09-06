# Mini Template

A small, dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

It supports escaped `{{paths}}`, raw `{{{paths}}}`, nested `#if` and `#each`
blocks (including `{{this}}` and `{{@index}}`), comments, and `{{else}}`.
Missing values render empty; invalid block structure and object/function
interpolations throw location-aware errors.

Render files from the command line:

```sh
bun run src/cli.ts template.html data.json
```

Run the self-tests with `bun test`.
