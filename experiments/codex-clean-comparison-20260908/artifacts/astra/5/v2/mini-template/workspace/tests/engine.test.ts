import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("render", () => {
  test("escaping, raw text, comments, and exact whitespace", () => {
    expect(render(' \n{{ value }}|{{{value}}}{{! ignored }}\t', { value: '&<>"\'' }))
      .toBe(' \n&amp;&lt;&gt;&quot;&#39;|&<>"\'\t');
  });
  test("scalars, missing paths, and nullish values", () => {
    expect(render('{{a.b}}/{{missing}}/{{nil}}/{{zero}}/{{no}}/{{big}}',
      { a: { b: 'ok' }, nil: null, zero: 0, no: false, big: 12n })).toBe('ok///0/false/12');
    expect(render('{{this}}', 'root')).toBe('root');
    expect(render('{{a.b}}', null)).toBe('');
  });
  test("truthiness", () => {
    for (const value of ['', 0, false, null, undefined, [], -0, 0n]) {
      expect(render('{{#if value}}T{{else}}F{{/if}}', { value })).toBe('F');
    }
    for (const value of ['0', 1, true, {}, [0], NaN, 1n, () => 1]) {
      expect(render('{{#if value}}T{{else}}F{{/if}}', { value })).toBe('T');
    }
  });
  test("nested conditionals and optional else", () => {
    expect(render('{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}', { a: true, b: false })).toBe('AC');
    expect(render('{{#if missing}}x{{/if}}', {})).toBe('');
  });
  test("nested loops, root fallback, and context restoration", () => {
    const template = '{{#each groups}}{{@index}}:{{name}}/{{title}}[{{#each rows}}{{@index}}={{this}}/{{title}};{{/each}}]{{@index}}:{{this.name}}|{{/each}}';
    expect(render(template, { title: 'R', groups: [{ name: 'A', rows: ['x', 'y'] }, { name: 'B', rows: ['z'] }] }))
      .toBe('0:A/R[0=x/R;1=y/R;]0:A|1:B/R[0=z/R;]1:B|');
  });
  test("each else and enclosing context", () => {
    for (const items of [[], undefined, null, false, {}, 'text']) {
      expect(render('{{#each items}}x{{else}}{{title}}{{/each}}', { items, title: 'empty' })).toBe('empty');
    }
    expect(render('{{#each items}}{{#each this.rows}}x{{else}}{{@index}}:{{this.name}}{{/each}}{{/each}}', { items: [{ name: 'A', rows: [] }] })).toBe('0:A');
  });
  test("own properties, full-path fallback, and explicit this", () => {
    expect(render('{{toString}}/{{constructor}}', {})).toBe('/');
    expect(render('{{#each items}}{{a.b}}/{{nil}}/{{this.title}}{{/each}}', {
      a: { b: 'root' }, nil: 'fallback', title: 'root', items: [{ a: {}, nil: undefined }],
    })).toBe('root//');
  });
  test("non-scalar values have located errors in escaped and raw tags", () => {
    for (const value of [{}, [], () => 1, Symbol('x')]) {
      for (const tag of ['{{value}}', '{{{value}}}']) {
        expect(() => render('\n  ' + tag, { value })).toThrow(/non-scalar.*line 2, column 3/);
      }
    }
  });
  test.each([
    ['{{#wat x}}', /Unknown block/],
    ['{{#if x}}{{/each}}', /Mismatched/],
    ['{{/if}}', /Unexpected closing/],
    ['{{#each x}}', /Unclosed each/],
    ['{{#if x}}{{else}}{{else}}{{/if}}', /Duplicate else/],
    ['{{else}}', /else outside/],
    ['{{#if}}', /Invalid path/],
    ['{{x', /Unclosed tag/],
    ['{{{x}}', /Unclosed tag/],
  ])('rejects structural mistake %s', (template, error) => {
    expect(() => render(template, {})).toThrow(error);
    expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
  });
  test("reports exact structural position and validates inactive branches", () => {
    expect(() => render('one\n  {{else}}', {})).toThrow('line 2, column 3');
    expect(() => render('{{#if missing}}{{#bad x}}{{/bad}}{{/if}}', {})).toThrow('Unknown block');
  });
});
