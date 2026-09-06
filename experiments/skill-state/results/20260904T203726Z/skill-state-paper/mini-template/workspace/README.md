# Mini Template

A dependency-free TypeScript template renderer for Bun.

```sh
bun test.ts
bun run src/cli.ts template.txt data.json
```

The CLI writes rendered text to standard output and errors to standard error.

## Syntax

- `{{path.to.value}}`: HTML-escaped interpolation.
- `{{{path.to.value}}}`: unescaped interpolation.
- `{{#if path}}...{{else}}...{{/if}}`: conditional content.
- `{{#each path}}...{{else}}...{{/each}}`: array iteration, with `{{this}}` and `{{@index}}`.
- `{{! comment }}`: comment.

Missing values render as empty strings. Objects and functions cannot be interpolated as text and throw an error.
