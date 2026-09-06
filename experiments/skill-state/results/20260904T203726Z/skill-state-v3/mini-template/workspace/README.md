# Mini Template

A dependency-free TypeScript template renderer for Bun.

```sh
bun run src/cli.ts template.txt data.json
bun test.ts
```

Supported syntax: escaped `{{path}}`, unescaped `{{{path}}}`, comments
`{{! comment }}`, nested `{{#if path}}...{{else}}...{{/if}}`, and nested
`{{#each path}}...{{else}}...{{/each}}`. In loops, `{{this}}` and
`{{@index}}` refer to the current item and index; other paths fall back to
the root data object. Missing values render empty, while objects and functions
are rejected rather than stringified.
