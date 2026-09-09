import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes all HTML characters and supports raw values", () => {
    expect(render('{{x}}|{{{ x }}}', { x: '&<>"\'' })).toBe('&amp;&lt;&gt;&quot;&#39;|&<>"\'');
  });
  test("preserves whitespace and removes comments", () => {
    expect(render(' \n\t{{! ignored }}{{ user.name }}\r\n ', { user: { name: 'Ada' } })).toBe(' \n\tAda\r\n ');
    expect(render('plain\ntext', null)).toBe('plain\ntext');
    expect(render('', {})).toBe('');
  });
  test("missing/null values and scalar roots", () => {
    expect(render('{{missing}}/{{a.b}}/{{nil}}', { nil: null })).toBe('//');
    expect(render('{{this}}', 0)).toBe('0');
    expect(render('{{this}}', false)).toBe('false');
    expect(render('{{this}}', 12n)).toBe('12');
    expect(render('{{this}}', undefined)).toBe('');
  });
  test("rejects nonscalar text in both insertion modes", () => {
    for (const value of [{}, [], () => 1, Symbol('x')]) {
      for (const template of ['{{x}}', '{{{x}}}']) {
        expect(() => render(template, { x: value })).toThrow(/expected scalar text/);
      }
    }
  });
  test("does not expose inherited properties", () => {
    expect(render('{{toString}}/{{constructor}}/{{__proto__}}', {})).toBe('//');
    expect(render('{{x}}', Object.create({ x: 'hidden' }))).toBe('');
  });
});

describe("blocks", () => {
  test("conditional truthiness", () => {
    for (const value of ['', 0, -0, false, null, undefined, [], NaN]) {
      expect(render('{{#if x}}yes{{else}}no{{/if}}', { x: value })).toBe('no');
    }
    for (const value of ['0', ' ', 1, true, {}, [false]]) {
      expect(render('{{#if x}}yes{{else}}no{{/if}}', { x: value })).toBe('yes');
    }
    expect(render('{{#if x}}yes{{/if}}', {})).toBe('');
  });
  test("nested conditions", () => {
    const template = '{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}';
    expect(render(template, { a: true, b: false })).toBe('AC');
    expect(render(template, { a: false, b: true })).toBe('D');
  });
  test("arrays with item lookup and root fallback", () => {
    expect(render('{{#each items}}{{@index}}={{this}}/{{title}};{{/each}}', { title: 'T', items: ['a', 'b'] })).toBe('0=a/T;1=b/T;');
    expect(render('{{#each items}}{{name}}/{{this.name}};{{/each}}', { name: 'root', items: [{ name: 'local' }, {}] })).toBe('local/local;root/;');
  });
  test("fallback distinguishes missing paths from explicit null/undefined", () => {
    expect(render('{{#each items}}[{{a.b}}]{{/each}}', { a: { b: 'root' }, items: [{ a: {} }, { a: { b: null } }, { a: { b: undefined } }] })).toBe('[root][][]');
  });
  test("empty or non-array each values use else", () => {
    for (const items of [[], null, undefined, {}, false, 'abc', 3]) {
      expect(render('{{#each items}}x{{else}}empty{{/each}}', { items })).toBe('empty');
      expect(render('{{#each items}}x{{/each}}', { items })).toBe('');
    }
  });
  test("nested loops restore item and index; if retains loop context", () => {
    const template = '{{#each groups}}{{@index}}:{{name}}[{{#each children}}{{@index}}={{this}}/{{title}};{{else}}{{name}}{{/each}}]{{#if name}}{{this.name}}/{{@index}}{{/if}}|{{/each}}';
    expect(render(template, { title: 'R', groups: [{ name: 'A', children: ['x', 'y'] }, { name: 'B', children: [] }] })).toBe('0:A[0=x/R;1=y/R;]A/0|1:B[B]B/1|');
  });
});

describe("diagnostics", () => {
  const cases: [string, RegExp][] = [
    ['{{#unknown x}}{{/unknown}}', /Unknown block/],
    ['{{#if x}}{{/each}}', /Mismatched closing tag/],
    ['{{/if}}', /Unexpected closing tag/],
    ['{{#if x}}', /Unclosed if block/],
    ['{{#each x}}', /Unclosed each block/],
    ['{{#if x}}{{else}}{{else}}{{/if}}', /Duplicate else/],
    ['{{else}}', /else outside a block/],
    ['{{x', /Unclosed tag/],
    ['{{{x}}', /Unclosed tag/],
    ['{{#if}}', /Invalid path/],
    ['{{a..b}}', /Invalid path/],
  ];
  for (const [template, error] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(error);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    });
  }
  test("reports precise source positions", () => {
    expect(() => render('one\n  {{else}}', {})).toThrow('line 2, column 3');
    expect(() => render('one\r\n  {{x}}', { x: {} })).toThrow('line 2, column 3');
  });
  test("checks structural errors in inactive branches", () => {
    expect(() => render('{{#if absent}}{{#wat x}}{{/wat}}{{/if}}', {})).toThrow(/Unknown block/);
  });
});
