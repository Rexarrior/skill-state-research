import { describe, expect, test } from 'bun:test';
import { render } from './engine';

describe('render', () => {
  test('escaping, raw values, missing values, and exact whitespace', () => {
    expect(render(' \n{{x}}|{{{x}}}|{{missing}}\t', { x: '&<>"\'' }))
      .toBe(' \n&amp;&lt;&gt;&quot;&#39;|&<>"\'|\t');
    expect(render('{{a.b}}/{{zero}}/{{no}}', { a: { b: 12 }, zero: 0, no: false })).toBe('12/0/false');
  });
  test('truthiness and nested conditional branches', () => {
    for (const value of ['', 0, -0, false, null, undefined, []]) {
      expect(render('{{#if x}}yes{{else}}no{{/if}}', { x: value })).toBe('no');
    }
    for (const value of [{}, [0], '0', -1, true, NaN]) {
      expect(render('{{#if x}}{{#if missing}}bad{{else}}yes{{/if}}{{else}}no{{/if}}', { x: value })).toBe('yes');
    }
  });
  test('nested loops, root fallback, and restored indices', () => {
    const template = '{{#each groups}}{{@index}}[{{#each members}}{{@index}}={{this}}/{{title}};{{/each}}]{{@index}}{{/each}}';
    expect(render(template, { title: 'R', groups: [{ members: ['a', 'b'] }, { members: ['c'] }] }))
      .toBe('0[0=a/R;1=b/R;]01[0=c/R;]1');
    expect(render('{{#each items}}{{name}}:{{this.name}};{{/each}}', { name: 'root', items: [{ name: 'local' }, {}, { name: null }] }))
      .toBe('local:local;root:;:;');
  });
  test('each else and comments', () => {
    for (const items of [[], null, 42, {}]) {
      expect(render('a{{! ignored }}{{#each items}}bad{{else}}{{title}}{{/each}}b', { items, title: 'empty' })).toBe('aemptyb');
    }
    expect(render('{{#each items}}{{#if this}}{{this}}{{else}}zero{{/if}}{{/each}}', { items: [0, 1] })).toBe('zero1');
  });
  test('own properties, root this, and full-path fallback', () => {
    expect(render('{{this.a.0}}|{{@index}}|{{toString}}', { a: ['ok'] })).toBe('ok||');
    expect(render('{{#each items}}{{a.b}}{{/each}}', { a: { b: 'root' }, items: [{ a: {} }] })).toBe('root');
  });
  test('non-scalar values fail even in raw tags', () => {
    for (const x of [{}, [], () => 1]) {
      for (const tag of ['{{x}}', '{{{x}}}']) expect(() => render(tag, { x })).toThrow(/non-scalar.*line 1, column 1/);
    }
    expect(render('{{#if no}}{{obj}}{{/if}}', { obj: {} })).toBe('');
  });
  test('structural errors carry positions, including in inactive branches', () => {
    for (const tag of ['{{#wat x}}', '{{/if}}', '{{else}}', '{{#if x}}{{/each}}', '{{#if x}}', '{{#each x}}{{else}}{{else}}{{/each}}', '{{x', '{{}}']) {
      expect(() => render('\n  ' + tag, {})).toThrow(/line \d+, column \d+/);
    }
    expect(() => render('first\n  {{/if}}', {})).toThrow('line 2, column 3');
    expect(() => render('{{#if no}}{{#unknown x}}{{/if}}', {})).toThrow(/Unknown/);
  });
});
