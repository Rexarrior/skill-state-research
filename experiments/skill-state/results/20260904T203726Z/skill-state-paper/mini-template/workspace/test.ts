import { render } from "./src/engine";

function equal(actual: string, expected: string): void {
  if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

equal(render("Hello {{name}}!", { name: "A&B" }), "Hello A&amp;B!");
equal(render("{{{html}}}", { html: "<b>ok</b>" }), "<b>ok</b>");
equal(render("{{#if active}}yes{{else}}no{{/if}}", { active: false }), "no");
equal(render("{{#if items}}yes{{else}}no{{/if}}", { items: [] }), "no");
equal(render("{{#each items}}[{{@index}}:{{this}}/{{title}}]{{else}}empty{{/each}}", { title: "T", items: ["a", "b"] }), "[0:a/T][1:b/T]");
equal(render("{{#each rows}}{{#each this}}({{@index}}:{{this}}){{/each}}{{/each}}", { rows: [["a", "b"], ["c"]] }), "(0:a)(1:b)(0:c)");
equal(render("a{{! ignored }}b {{missing}}", {}), "ab ");

for (const template of ["{{else}}", "{{#if ok}}{{else}}{{else}}{{/if}}", "{{#if ok}}", "{{#if ok}}{{/each}}", "{{#wat ok}}{{/wat}}"])
  try { render(template, {}); throw new Error(`Expected ${template} to throw`); } catch (error) {
    if (!(error instanceof Error) || !/line \d+, column \d+/.test(error.message)) throw error;
  }

try { render("{{value}}", { value: {} }); throw new Error("Expected object interpolation to throw"); } catch (error) {
  if (!(error instanceof Error) || !error.message.includes("object or function")) throw error;
}

console.log("All tests passed");
