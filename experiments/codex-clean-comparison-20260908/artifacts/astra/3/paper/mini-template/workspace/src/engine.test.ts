import { describe, expect, test } from 'bun:test';
import { render } from './engine';

describe('render', () => {
  test('escaping, raw values, comments and whitespace', () => {
    expect(render(' \n{{ value }}|{{{value}}}{{! ignored }}\t', { value: '&<>"\'' }))
      .toBe(' \n&amp;&lt;&gt;&quot;&#39;|&<>"\'\t');
    expect(render('', {})).toBe('');
    expect(render('plain\r\n text', {})).toBe('plain\r\n text');
  });
  test('paths, missing and scalar values', () => {
    expect(render('{{a.b}}|{{absent}}|{{nil}}|{{zero}}|{{bool}}', { a: { b: 42 }, nil: null, zero: 0, bool: false })).toBe('42|||0|false');
    expect(render('{{this}}', 'root')).toBe('root');
    expect(render('{{toString}}', {})).toBe('');
    expect(render('{{a}}', Object.create({ a: 'inherited' }))).toBe('');
  });
  test('truthiness and nested conditions', () => {
    for (const value of ['', 0, false, null, undefined, [], NaN]) {
      expect(render('{{#if value}}yes{{else}}no{{/if}}', { value })).toBe('no');
    }
    for (const value of ['0', 1, true, {}, [0]]) {
      expect(render('{{#if value}}yes{{else}}no{{/if}}', { value })).toBe('yes');
    }
    expect(render('{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}', { a: true, b: false })).toBe('AC');
    expect(render('{{#if absent}}x{{/if}}', {})).toBe('');
  });
  test('each contexts, nested loops and root fallback', () => {
    const data = { title: 'Root', groups: [{ title: 'Local', items: ['a', 'b'] }, { items: [] }] };
    const template = '{{#each groups}}{{@index}}/{{title}}:{{#each items}}{{@index}}={{this}}/{{title}};{{else}}empty{{/each}}({{@index}}){{/each}}';
    expect(render(template, data)).toBe('0/Local:0=a/Root;1=b/Root;(0)1/Root:empty(1)');
    expect(render('{{#each items}}{{this.name}}:{{name}}:{{x}}{{/each}}', { name: 'root', x: 'fallback', items: [{ name: null }] })).toBe('::fallback');
    for (const items of [[], null, 3, {}, undefined]) {
      expect(render('{{#each items}}x{{else}}empty{{/each}}', { items })).toBe('empty');
    }
  });
  test('non-scalars fail clearly, including raw interpolations', () => {
    for (const value of [{}, [], () => 1]) {
      expect(() => render('\n{{value}}', { value })).toThrow(/scalar text.*line 2, column 1/);
      expect(() => render('{{{value}}}', { value })).toThrow('scalar text');
    }
  });
  test('structural errors have useful locations', () => {
    for (const [template, message] of [
      ['{{#wat x}}{{/wat}}', 'Unknown block'],
      ['{{#if x}}{{/each}}', 'Mismatched closing'],
      ['{{/if}}', 'Unexpected closing'],
      ['{{#each x}}', 'Unclosed each'],
      ['{{#if x}}{{else}}{{else}}{{/if}}', 'Duplicate else'],
      ['{{else}}', 'else outside'],
      ['{{x', 'Unclosed tag'],
      ['{{#if}}', 'Invalid path'],
    ]) {
      expect(() => render(template!, {})).toThrow(message!);
      expect(() => render(template!, {})).toThrow(/line \d+, column \d+/);
    }
    expect(() => render('hello\n  {{else}}', {})).toThrow('line 2, column 3');
    expect(() => render('{{#if absent}}{{#unknown x}}{{/unknown}}{{/if}}', {})).toThrow('Unknown block');
  });
});
