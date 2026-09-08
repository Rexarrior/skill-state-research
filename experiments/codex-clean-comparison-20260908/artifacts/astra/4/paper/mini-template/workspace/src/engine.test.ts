import { describe, expect, test } from 'bun:test';
import { render } from './engine';

describe('renderer', () => {
  test('escaping, raw values, missing and exact whitespace', () => {
    expect(render(' \n{{value}}|{{{value}}}|{{missing}}\t{{! ignored }}\n', { value: `&<>"'` }))
      .toBe(' \n&amp;&lt;&gt;&quot;&#39;|&<>"\'|\t\n');
    expect(render('{{a.b}}/{{n}}/{{f}}/{{z}}', { a: { b: 'ok' }, n: null, f: false, z: 0 })).toBe('ok//false/0');
  });
  test('truthiness and nested conditions', () => {
    for (const value of ['', 0, false, null, undefined, []]) expect(render('{{#if this}}Y{{else}}N{{/if}}', value)).toBe('N');
    for (const value of ['0', 1, true, {}, [0]]) expect(render('{{#if this}}Y{{else}}N{{/if}}', value)).toBe('Y');
    expect(render('{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}', { a: true, b: false })).toBe('AC');
  });
  test('nested loops, root fallback and context restoration', () => {
    const template = '{{#each groups}}{{@index}}/{{name}}/{{title}}:{{#each values}}{{@index}}={{this}}/{{title}};{{else}}none{{/each}}@{{@index}}{{/each}}';
    expect(render(template, { title: 'R', groups: [{ name: 'A', values: [2, 3] }, { name: 'B', values: [] }] }))
      .toBe('0/A/R:0=2/R;1=3/R;@01/B/R:none@1');
    expect(render('{{#each list}}{{name}}|{{this.missing}}{{/each}}', { name: 'root', missing: 'root', list: [{ name: null }, {}] })).toBe('|root|');
    for (const list of [[], null, {}, 4]) expect(render('{{#each list}}x{{else}}{{title}}{{/each}}', { list, title: 'empty' })).toBe('empty');
  });
  test('own properties and scalar rejection', () => {
    expect(render('{{inherited}}/{{toString}}', Object.create({ inherited: 'hidden' }))).toBe('/');
    for (const value of [{}, [], () => 1]) {
      expect(() => render('\n{{this}}', value)).toThrow('non-scalar');
      expect(() => render('{{{this}}}', value)).toThrow('non-scalar');
    }
    expect(render('{{this}}', 12n)).toBe('12');
  });
  test('structural errors include source positions even in inactive branches', () => {
    for (const text of ['{{#wat x}}', '{{/if}}', '{{else}}', '{{#if x}}{{/each}}', '{{#if x}}{{else}}{{else}}{{/if}}', '{{#each x}}', '{{x', '{{}}']) {
      expect(() => render('text\n  ' + text, {})).toThrow(/line \d+, column \d+/);
    }
    expect(() => render('text\n  {{/if}}', {})).toThrow('line 2, column 3');
    expect(() => render('{{#if absent}}{{#unknown x}}{{/if}}', {})).toThrow('Unknown');
  });
});
