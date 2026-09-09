import { describe, expect, test } from 'bun:test';
import { render } from '../src/engine';

describe('render', () => {
  test('escapes all HTML characters and supports raw values', () => {
    expect(render('{{x}}|{{{x}}}', { x: `&<>"'` })).toBe('&amp;&lt;&gt;&quot;&#39;|&<>"\'');
  });
  test('preserves whitespace, comments, and scalar values', () => {
    expect(render(' \n{{! ignored }}\t{{a.b}}/{{missing}}/{{nil}}/{{f}}/{{n}}\n', { a: { b: 'ok' }, nil: null, f: false, n: 0 })).toBe(' \n\tok///false/0\n');
    expect(render('{{this}}', 42n)).toBe('42');
  });
  test('if truthiness and nesting', () => {
    for (const x of ['', 0, false, null, undefined, []]) expect(render('{{#if x}}Y{{else}}N{{/if}}', { x })).toBe('N');
    for (const x of ['0', 1, true, {}, [0]]) expect(render('{{#if x}}Y{{else}}N{{/if}}', { x })).toBe('Y');
    expect(render('{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}', { a: true, b: false })).toBe('AC');
  });
  test('nested loops resolve items and root, then restore context', () => {
    const template = '{{#each rows}}{{@index}}/{{name}}/{{title}}:{{#each cells}}{{@index}}={{this}}/{{title}};{{/each}}{{name}}/{{@index}}|{{/each}}';
    expect(render(template, { title: 'T', rows: [{ name: 'A', cells: [1, 2] }, { name: 'B', cells: [3] }] })).toBe('0/A/T:0=1/T;1=2/T;A/0|1/B/T:0=3/T;B/1|');
  });
  test('each else and explicit this paths', () => {
    for (const items of [[], null, undefined, {}, 'abc']) expect(render('{{#each items}}Y{{else}}N{{/each}}', { items })).toBe('N');
    expect(render('{{#each items}}{{this.name}}/{{name}}/{{x}};{{/each}}', { name: 'root', x: 'fallback', items: [{ name: null }, {}] })).toBe('//fallback;/root/fallback;');
  });
  test('inherited properties are inaccessible', () => {
    expect(render('{{toString}}/{{constructor}}/{{x.y}}', { x: Object.create({ y: 'no' }) })).toBe('//');
  });
  test('rejects nonscalar values with locations', () => {
    for (const x of [{}, [], () => 1, Symbol('x')]) expect(() => render('\n {{{x}}}', { x })).toThrow(/scalar text.*line 2, column 2/);
  });
  test('structural errors include useful locations even in inactive branches', () => {
    for (const [text, message] of [
      ['\n {{#wat x}}', /Unknown block.*line 2, column 2/],
      ['{{#if x}}{{/each}}', /Mismatched.*line 1, column 10/],
      ['{{#if x}}', /Unclosed if.*line 1, column 1/],
      ['{{/if}}', /Unexpected closing.*line 1, column 1/],
      ['{{else}}', /else outside.*line 1, column 1/],
      ['{{#each x}}{{else}}{{else}}{{/each}}', /Duplicate else.*line 1, column 20/],
      ['{{#if x}}{{#wat x}}{{/if}}', /Unknown block/],
      ['{{x', /Unclosed tag/],
      ['{{#if}}', /Missing path/],
    ] as const) expect(() => render(text, {})).toThrow(message);
  });
});
