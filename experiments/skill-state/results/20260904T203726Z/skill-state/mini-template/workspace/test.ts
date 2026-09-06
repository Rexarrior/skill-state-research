import { render } from "./src/engine.ts";

const equal = (actual: string, expected: string): void => {
  if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const throws = (template: string, message: string, data: unknown = {}): void => {
  try { render(template, data); } catch (error) {
    if (error instanceof Error && error.message.includes(message)) return;
    throw error;
  }
  throw new Error(`Expected error containing ${message}`);
};

equal(render("Hi {{user.name}}", { user: { name: "Ada & Bob" } }), "Hi Ada &amp; Bob");
equal(render("{{{value}}}", { value: "<b>ok</b>" }), "<b>ok</b>");
equal(render("{{#if ok}}yes{{else}}no{{/if}}", { ok: false }), "no");
equal(render("{{#if list}}yes{{else}}no{{/if}}", { list: [] }), "no");
equal(render("{{#each items}}[{{@index}}:{{this}}/{{title}}]{{else}}empty{{/each}}", { title: "T", items: ["a", "b"] }), "[0:a/T][1:b/T]");
equal(render("{{#each groups}}{{#each this}}{{@index}}{{this}}{{/each}}{{/each}}", { groups: [["a"], ["b"]] }), "0a0b");
equal(render("a{{! ignored }}b{{missing}}", {}), "ab");
throws("{{#if ok}}{{/each}}", "Mismatched");
throws("{{else}}", "outside");
throws("{{#if ok}}{{else}}{{else}}{{/if}}", "Duplicate");
throws("{{#if ok}}", "Unclosed");
throws("{{value}}", "object", { value: {} });

console.log("All self-tests passed.");
