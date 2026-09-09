import { describe, expect, test } from 'bun:test';
import { render } from '../src/engine';

describe('render', () => {
  test('escaping, raw values, dotted paths, missing values and whitespace', () => {
    expect(render(' \n{{user.name}}|{{{user.name}}}|{{absent}}\t', { user: { name: '&<>"\'' } }))
      .toBe(' \n&amp;&lt;&gt;&quot;&#39;|&<>"\'|\t');
    expect(render('{{x}}/{{y}}/{{z}}', { x: 0, y: false, z: null })).toBe('0/false/');
    expect(render('{{this}}', 'hello')).toBe('hello');
  });
  test('truthiness and nested conditionals', () => {
    for (const value of ['', 0, false, null, undefined, []]) {
      expect(render('{{#if value}}yes{{else}}no{{/if}}', { value })).toBe('no');
    }
    for (const value of [1, '0', {}, [0], true]) {
      expect(render('{{#if value}}yes{{else}}no{{/if}}', { value })).toBe('yes');
    }
    expect(render('{{#if missing}}bad{{else}}{{#if ok}}good{{else}}bad{{/if}}{{/if}}', { ok: true })).toBe('good');
  });
  test('nested loops, indices, local properties and root fallback', () => {
    const template = '{{#each groups}}{{@index}}:{{name}}/{{title}}[{{#each items}}{{@index}}={{this}}/{{title}};{{else}}none{{/each}}]{{/each}}';
    expect(render(template, { title: 'Root', groups: [{ name: 'A', items: ['x', 'y'] }, { name: 'B', items: [] }] }))
      .toBe('0:A/Root[0=x/Root;1=y/Root;]1:B/Root[none]');
    expect(render('{{#each rows}}{{name}}/{{this.missing}}/{{missing}}{{/each}}', { name: 'Root', missing: 'fallback', rows: [{ name: null }] })).toBe('//fallback');
    expect(render('{{#each a}}{{#each b}}{{this}}{{/each}}:{{@index}}:{{this.name}}{{/each}}', { a: [{ name: 'a', b: [1] }] })).toBe('1:0:a');
  });
  test('each else, comments, and own properties', () => {
    for (const items of [[], null, undefined, {}, 3]) expect(render('{{#each items}}bad{{else}}empty{{/each}}', { items })).toBe('empty');
    expect(render('a{{! ignored }} b\n', {})).toBe('a b\n');
    expect(render('{{toString}}', {})).toBe('');
    expect(render('{{items.0}}', { items: ['first'] })).toBe('first');
  });
  test('structural errors include useful locations', () => {
    for (const [template, message] of [
      ['{{#wat x}}', 'Unknown or invalid block'],
      ['{{/if}}', 'Unexpected closing'],
      ['{{#if x}}{{/each}}', 'Mismatched closing'],
      ['{{#each x}}', 'Unclosed each'],
      ['{{#if x}}{{else}}{{else}}{{/if}}', 'Duplicate else'],
      ['{{else}}', 'else outside'],
      ['{{x', 'Unclosed tag'],
      ['{{}}', 'Empty interpolation'],
      ['{{#if absent}}{{#bad x}}{{/if}}', 'Unknown or invalid block'],
    ]) {
      expect(() => render(template, {})).toThrow(message);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    }
    expect(() => render('ok\n  {{else}}', {})).toThrow('line 2, column 3');
  });
  test('non-scalar values fail for escaped and raw insertions', () => {
    for (const x of [{}, [], () => 1]) {
      for (const template of ['{{x}}', '{{{x}}}']) expect(() => render(template, { x })).toThrow('scalar text');
    }
  });
});
