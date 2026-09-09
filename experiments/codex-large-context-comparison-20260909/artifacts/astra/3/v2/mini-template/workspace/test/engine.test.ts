import { describe, expect, test } from "bun:test";
import { render } from "../src/engine";

describe("interpolation", () => {
  test("escapes all HTML characters and permits raw text", () => {
    expect(render('{{ value }}|{{{value}}}', { value: '&<>"\'' })).toBe('&amp;&lt;&gt;&quot;&#39;|&<>"\'');
  });
  test("preserves text and whitespace and removes comments", () => {
    expect(render(' a\r\n {{! ignored }}\t{{x}}\n', { x: 'b' })).toBe(' a\r\n \tb\n');
    expect(render('', {})).toBe('');
  });
  test("resolves deep paths and missing values", () => {
    expect(render('{{a.b.0}}/{{absent.x}}/{{nil}}/{{zero}}/{{bool}}/{{big}}', {
      a: { b: ['yes'] }, nil: null, zero: 0, bool: false, big: 42n,
    })).toBe('yes///0/false/42');
    expect(render('{{this}}', 'root')).toBe('root');
    expect(render('{{x}}', null)).toBe('');
  });
  test("does not resolve inherited properties", () => {
    expect(render('{{secret}}/{{toString}}/{{__proto__.secret}}', Object.create({ secret: 'no' }))).toBe('//');
  });
  for (const value of [{}, [], () => 1, Symbol('x')]) {
    test(`rejects nonscalar ${typeof value} values`, () => {
      expect(() => render('\n  {{x}}', { x: value })).toThrow(/scalar text.*line 2, column 3/);
      expect(() => render('{{{x}}}', { x: value })).toThrow(/scalar text/);
    });
  }
});

describe("blocks", () => {
  for (const value of ['', 0, 0n, false, null, undefined, []]) {
    test(`false branch for ${String(value)}`, () => {
      expect(render('{{#if v}}T{{else}}F{{/if}}', { v: value })).toBe('F');
    });
  }
  for (const value of ['0', 1, true, {}, [0], NaN]) {
    test(`true branch for ${String(value)}`, () => {
      expect(render('{{#if v}}T{{else}}F{{/if}}', { v: value })).toBe('T');
    });
  }
  test('nested conditionals and optional else', () => {
    expect(render('{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}', { a: true, b: false })).toBe('AC');
    expect(render('{{#if missing}}x{{/if}}', {})).toBe('');
  });
  test('loops resolve local properties, this, index and root fallback', () => {
    expect(render('{{#each users}}{{@index}}={{name}}/{{this.name}}/{{title}};{{/each}}', {
      title: 'root', users: [{ name: 'A' }, { name: 'B', title: 'local' }],
    })).toBe('0=A/A/root;1=B/B/local;');
    expect(render('{{#each xs}}{{this}}{{/each}}', { xs: [0, false, null, 'x'] })).toBe('0falsex');
  });
  test('nested loops restore contexts and inherit context in empty else', () => {
    const template = '{{#each groups}}{{@index}}:{{#each members}}{{@index}}/{{this}}/{{title}};{{else}}{{this.name}}/{{@index}}{{/each}}:{{this.name}}/{{@index}}|{{/each}}';
    expect(render(template, { title: 'R', groups: [{ name: 'A', members: ['x', 'y'] }, { name: 'B', members: [] }] }))
      .toBe('0:0/x/R;1/y/R;:A/0|1:B/1:B/1|');
  });
  test('if preserves loop context', () => {
    expect(render('{{#each xs}}{{#if this}}{{@index}}={{this}}{{else}}no{{/if}}{{/each}}', { xs: [0, 'x'] })).toBe('no1=x');
  });
  test('existing undefined and null do not fall back', () => {
    expect(render('{{#each xs}}[{{name}}]{{/each}}', { name: 'root', xs: [{ name: undefined }, { name: null }, {}] })).toBe('[][][root]');
  });
  test('empty and non-array each select else', () => {
    for (const xs of [[], null, undefined, {}, 'abc', 3]) {
      expect(render('{{#each xs}}bad{{else}}empty{{/each}}', { xs })).toBe('empty');
      expect(render('{{#each xs}}bad{{/each}}', { xs })).toBe('');
    }
  });
});

describe('syntax errors', () => {
  const cases: [string, RegExp][] = [
    ['{{#wat x}}', /Unknown block/],
    ['{{#if x}}{{/each}}', /Mismatched closing/],
    ['{{/if}}', /Unexpected closing/],
    ['{{#if x}}', /Unclosed if block/],
    ['{{#each x}}', /Unclosed each block/],
    ['{{#if x}}{{else}}{{else}}{{/if}}', /Duplicate else/],
    ['{{else}}', /else outside/],
    ['{{x', /Unclosed tag/],
    ['{{{x}}', /Unclosed tag/],
    ['{{#if}}', /Invalid path/],
    ['{{a..b}}', /Invalid path/],
  ];
  for (const [template, message] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(message);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    });
  }
  test('locations and validation of inactive branches', () => {
    expect(() => render('abc\r\n  {{else}}', {})).toThrow('line 2, column 3');
    expect(() => render('{{#if false}}{{#unknown x}}{{/if}}', {})).toThrow(/Unknown block/);
  });
});
