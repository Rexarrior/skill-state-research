import { describe, expect, test } from 'bun:test';
import { render } from '../src/engine';

describe('render', () => {
  test('escapes all HTML characters and supports raw interpolation', () => {
    expect(render('{{x}}|{{{x}}}', { x: '&<>"\'' })).toBe('&amp;&lt;&gt;&quot;&#39;|&<>"\'');
  });
  test('preserves whitespace, ignores comments, and resolves missing values', () => {
    expect(render(' \n{{! ignored }}{{a.b}}/{{missing}}\t\n', { a: { b: 12 } })).toBe(' \n12/\t\n');
    expect(render('{{this}}', null)).toBe('');
    expect(render('{{this}}', false)).toBe('false');
  });
  test('uses specified truthiness', () => {
    for (const x of ['', 0, false, null, undefined, []]) expect(render('{{#if x}}yes{{else}}no{{/if}}', { x })).toBe('no');
    for (const x of ['0', 1, true, {}, [0]]) expect(render('{{#if x}}yes{{else}}no{{/if}}', { x })).toBe('yes');
  });
  test('nests conditionals and parses inactive branches', () => {
    expect(render('{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}', { a: true })).toBe('AC');
    expect(() => render('{{#if missing}}{{#wrong x}}{{/if}}', {})).toThrow(/block/);
  });
  test('iterates primitives and handles empty or non-array input', () => {
    expect(render('{{#each xs}}{{@index}}:{{this}};{{else}}empty{{/each}}', { xs: ['a', 'b'] })).toBe('0:a;1:b;');
    for (const xs of [[], undefined, {}, 'abc']) expect(render('{{#each xs}}x{{else}}empty{{/each}}', { xs })).toBe('empty');
  });
  test('nested loops restore context and fall back to root', () => {
    const template = '{{#each rows}}{{name}}:{{#each this.values}}{{@index}}={{this}}/{{title}};{{/each}}[{{@index}}]{{/each}}';
    expect(render(template, { title: 'R', rows: [{ name: 'A', values: [2, 3] }, { name: 'B', values: [4] }] })).toBe('A:0=2/R;1=3/R;[0]B:0=4/R;[1]');
    expect(render('{{#each rows}}{{x}}/{{this.x}}{{/each}}', { x: 'root', rows: [{ x: null }, {}] })).toBe('/root/');
  });
  test('only resolves own properties', () => {
    expect(render('{{constructor}}/{{__proto__.x}}/{{toString}}', {})).toBe('//');
  });
  test('rejects non-scalar interpolation with locations', () => {
    for (const x of [{}, [], () => 1]) {
      expect(() => render('text\n  {{x}}', { x })).toThrow(/non-scalar.*line 2, column 3/);
      expect(() => render('{{{x}}}', { x })).toThrow(/non-scalar/);
    }
  });
  test('reports structural errors with line and column', () => {
    for (const template of ['{{#wat x}}', '{{/if}}', '{{else}}', '{{#if x}}{{/each}}', '{{#each x}}', '{{#if x}}{{else}}{{else}}{{/if}}', '{{x']) {
      expect(() => render('\n  ' + template, {})).toThrow(/line \d+, column \d+/);
    }
    expect(() => render('\n  {{#if x}}', {})).toThrow(/line 2, column 3/);
  });
});
