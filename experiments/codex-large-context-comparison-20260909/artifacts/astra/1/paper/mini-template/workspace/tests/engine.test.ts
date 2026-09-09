import { describe, expect, test } from 'bun:test';
import { render } from '../src/engine';

describe('render', () => {
  test('escaping, raw values, scalars, missing paths and whitespace', () => {
    expect(render(' \n{{ x }}|{{{x}}}|{{n}}|{{b}}|{{missing}}|{{nil}}\t', {
      x: '&<>"\'', n: 42, b: false, nil: null,
    })).toBe(' \n&amp;&lt;&gt;&quot;&#39;|&<>"\'|42|false||\t');
    expect(render('{{a.b}} {{! ignored }}{{this}}', 'root')).toBe(' root');
    expect(render('', {})).toBe('');
  });

  test('conditional truthiness', () => {
    for (const value of ['', 0, false, null, undefined, []]) {
      expect(render('{{#if value}}Y{{else}}N{{/if}}', { value })).toBe('N');
    }
    for (const value of ['0', 1, true, {}, [0]]) {
      expect(render('{{#if value}}Y{{else}}N{{/if}}', { value })).toBe('Y');
    }
    expect(render('{{#if missing}}Y{{else}}{{#if ok}}yes{{/if}}{{/if}}', { ok: true })).toBe('yes');
  });

  test('nested loops, item lookup, root fallback and restored contexts', () => {
    const template = '{{#each groups}}{{@index}}={{name}}:{{#each children}}{{@index}}/{{this}}/{{title}};{{/each}}({{@index}}/{{this.name}}){{/each}}';
    expect(render(template, { title: 'R', groups: [{ name: 'A', children: ['x', 'y'] }, { name: 'B', children: ['z'] }] }))
      .toBe('0=A:0/x/R;1/y/R;(0/A)1=B:0/z/R;(1/B)');
    expect(render('{{#each xs}}[{{name}}]{{/each}}', { name: 'root', xs: [{}, { name: null }, { name: 'local' }] })).toBe('[root][][local]');
  });

  test('each else and surrounding context', () => {
    for (const xs of [[], null, undefined, {}, 'text', 1]) {
      expect(render('{{#each xs}}bad{{else}}empty{{/each}}', { xs })).toBe('empty');
    }
    expect(render('{{#each xs}}{{#each this.empty}}bad{{else}}{{this.name}}/{{@index}}{{/each}}{{/each}}', { xs: [{ name: 'a', empty: [] }] })).toBe('a/0');
    expect(render('{{#each xs}}{{this}}{{/each}}', { xs: [0, false, null] })).toBe('0false');
  });

  test('does not traverse inherited properties', () => {
    expect(render('{{constructor}}|{{toString}}|{{a.x}}', { a: Object.create({ x: 1 }) })).toBe('||');
  });

  test('structural errors have locations even in inactive branches', () => {
    for (const tag of ['{{#wat x}}', '{{/if}}', '{{else}}', '{{#if x}}', '{{#each x}}{{/if}}', '{{#if x}}{{else}}{{else}}{{/if}}', '{{x', '{{}}']) {
      expect(() => render(`ok\n  ${tag}`, {})).toThrow(/line 2, column \d+/);
    }
    expect(() => render('{{#if missing}}{{#unknown x}}{{/if}}', {})).toThrow('Unknown');
    expect(() => render('ok\n  {{/each}}', {})).toThrow('line 2, column 3');
  });

  test('non-scalar values fail clearly in escaped and raw tags', () => {
    for (const value of [{}, [], () => 1]) {
      for (const tag of ['{{value}}', '{{{value}}}']) {
        expect(() => render(tag, { value })).toThrow(/non-scalar.*value.*line 1, column 1/);
      }
    }
  });
});
