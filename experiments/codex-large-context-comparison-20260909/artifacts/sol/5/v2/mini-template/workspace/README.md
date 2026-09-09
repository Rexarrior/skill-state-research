# Mini Template

A dependency-free TypeScript template renderer for Bun.

```ts
import { render } from "./src/engine";

render("Hello, {{user.name}}!", { user: { name: "Ada" } });
```

Supported tags are escaped `{{path}}`, raw `{{{path}}}`, conditionals with optional `{{else}}`, array loops with `{{this}}` and `{{@index}}`, and `{{! comments }}`. Paths inside loops first inspect the current item and then fall back to root data.

Run the CLI with:

```sh
bun run src/cli.ts template.txt data.json
```

It writes only rendered text to stdout. Errors are written to stderr with a non-zero exit status.

Run self-tests with `bun test`.
