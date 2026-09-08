import { describe, expect, test } from 'bun:test';
import { render } from './engine';

describe('render', () => {
  test('escaping, raw text, missing values, comments and whitespace', () => {
    expect(render(' \n{{x}}|{{{x}}}|{{missing}}|{{! ignored }}\t', { x: '&<>"\'' }))
      .toBe(' \n&amp;&lt;&gt;&quot;&#39;|&<>"\'| |\t'.replace('| |', '||'));
    expect(render('{{a.b}}/{{a.c}}/{{n}}/{{f}}', { a: { b: 12 }, n: null, f: false })).toBe('12///false');
  });
  test('truthiness and nested conditions', () => {
    for (const x of ['', 0, false, null, undefined, [], NaN]) expect(render('{{#if x}}T{{else}}F{{/if}}', { x })).toBe('F');
    for (const x of ['0', 1, true, {}, [0]]) expect(render('{{#if x}}T{{else}}F{{/if}}', { x })).toBe('T');
    expect(render('{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}', { a: true })).toBe('AC');
  });
  test('nested loops restore contexts and fall back to root', () => {
    const template = '{{#each groups}}{{@index}}:{{name}}/{{title}}[{{#each children}}{{@index}}={{this}}:{{title}};{{else}}none{{/each}}]{{@index}}{{/each}}';
    expect(render(template, { title: 'root', groups: [{ name: 'A', children: [1, 2] }, { name: 'B', children: [] }] }))
      .toBe('0:A/root[0=1:root;1=2:root;]01:B/root[none]1');
    expect(render('{{#each x}}Y{{else}}N{{/each}}', {})).toBe('N');
    expect(render('{{#each x}}Y{{else}}N{{/each}}', { x: 'text' })).toBe('N');
  });
  test('own properties and explicit this', () => {
    expect(render('{{toString}}/{{constructor}}', {})).toBe('/');
    expect(render('{{#each items}}{{name}}:{{this.name}}:{{a.b}}{{/each}}', { name: 'root', a: { b: 'fallback' }, items: [{ name: null, a: {} }] })).toBe('::fallback');
    expect(render('{{this}}/{{@index}}', 'root')).toBe('root/');
    expect(render('{{a.0.x}}', { a: [{ x: 'yes' }] })).toBe('yes');
  });
  test('structural errors have positions', () => {
    for (const template of ['{{#wat x}}', '{{/if}}', '{{#if x}}{{/each}}', '{{#if x}}', '{{#if x}}{{else}}{{else}}{{/if}}', '{{else}}', '{{x', '{{#if}}']) {
      expect(() => render('\n  ' + template, {})).toThrow(/line \d+, column \d+/);
    }
    expect(() => render('\n  {{/if}}', {})).toThrow('line 2, column 3');
    expect(() => render('{{#if absent}}{{#bad x}}{{/bad}}{{/if}}', {})).toThrow('Unknown block');
  });
  test('non-scalars fail clearly in escaped and raw interpolation', () => {
    for (const x of [{}, [], () => 1]) {
      expect(() => render('{{x}}', { x })).toThrow('non-scalar');
      expect(() => render('{{{x}}}', { x })).toThrow('non-scalar');
    }
    expect(render('{{x}}', { x: 12n })).toBe('12');
  });
});
