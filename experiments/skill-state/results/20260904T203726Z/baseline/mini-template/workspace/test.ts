import { strict as assert } from "node:assert";
import { render } from "./src/engine";

assert.equal(render("Hello, {{user.name}}!", { user: { name: "Ada" } }), "Hello, Ada!");
assert.equal(render("{{value}}|{{{value}}}", { value: '<&>"\'' }), "&lt;&amp;&gt;&quot;&#39;|<&>\"'");
assert.equal(render("A{{! ignored }}B\n", {}), "AB\n");
assert.equal(render("{{#if items}}yes{{else}}no{{/if}}", { items: [] }), "no");
assert.equal(render("{{#if enabled}}yes{{else}}no{{/if}}", { enabled: true }), "yes");
assert.equal(render("{{#each users}}[{{@index}}:{{this.name}}/{{site}}]{{else}}none{{/each}}", { site: "example", users: [{ name: "A" }, { name: "B" }] }), "[0:A/example][1:B/example]");
assert.equal(render("{{#each rows}}{{this}}:{{#each groups}}{{this}}/{{@index}} {{/each}};{{/each}}", { rows: ["x", "y"], groups: ["a", "b"] }), "x:a/0 b/1 ;y:a/0 b/1 ;");
assert.equal(render("{{missing}}", {}), "");
assert.throws(() => render("{{#if ok}}", { ok: true }), /Unclosed 'if' block opened at line 1, column 1/);
assert.throws(() => render("{{else}}", {}), /'else' outside a block at line 1, column 1/);
assert.throws(() => render("{{#if ok}}{{else}}{{else}}{{/if}}", { ok: true }), /Duplicate 'else'/);
assert.throws(() => render("{{#if ok}}{{/each}}", { ok: true }), /Mismatched closing tag/);
assert.throws(() => render("{{value}}", { value: {} }), /Cannot render object as scalar text/);

console.log("All self-tests passed.");
