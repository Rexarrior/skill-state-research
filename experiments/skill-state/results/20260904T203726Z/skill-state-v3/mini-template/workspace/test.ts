import { render } from "./src/engine";

function equal(actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

equal(render("Hello, {{user.name}}!", { user: { name: "A&B" } }), "Hello, A&amp;B!");
equal(render("{{{html}}}", { html: "<b>ok</b>" }), "<b>ok</b>");
equal(render("{{#if ok}}yes{{else}}no{{/if}}", { ok: false }), "no");
equal(render("{{#if rows}}{{#each rows}}[{{@index}}:{{this}}/{{title}}]{{/each}}{{else}}empty{{/if}}", { rows: ["a", "b"], title: "T" }), "[0:a/T][1:b/T]");
equal(render("a{{! hidden }} b{{missing}}", {}), "a b");
for (const template of ["{{else}}", "{{#if x}}{{/each}}", "{{#if x}}", "{{#each x}}{{else}}{{else}}{{/each}}"] ) {
  let failed = false;
  try { render(template, {}); } catch { failed = true; }
  if (!failed) throw new Error(`Expected syntax error for ${template}`);
}
let failed = false;
try { render("{{value}}", { value: {} }); } catch { failed = true; }
if (!failed) throw new Error("Expected object rendering error");
console.log("All self-tests passed");
