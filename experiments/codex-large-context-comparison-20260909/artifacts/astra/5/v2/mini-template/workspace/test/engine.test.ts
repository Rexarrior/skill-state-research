import { describe, expect, test } from 'bun:test';
import { render } from '../src/engine.ts';

describe('interpolation', () => {
  test('escapes all five HTML characters and supports raw text', () => {
    expect(render('{{value}}|{{{value}}}', { value: `&<>"'` })).toBe('&amp;&lt;&gt;&quot;&#39;|&<>"\'');
  });
  test('preserves whitespace, supports dotted paths, and removes comments', () => {
    expect(render(' \r\n{{ user.names.0 }}\t{{! ignored }}\n', { user: { names: ['Ada'] } })).toBe(' \r\nAda\t\n');
  });
  test('handles missing, null, and scalar values', () => {
    expect(render('{{missing}}/{{nil}}/{{zero}}/{{no}}/{{n}}', { nil: null, zero: 0, no: false, n: 12 })).toBe('//0/false/12');
    expect(render('{{this}}', 'root')).toBe('root');
    expect(render('{{missing}}', null)).toBe('');
  });
  test('does not expose inherited properties', () => {
    expect(render('{{secret}}/{{constructor}}', Object.create({ secret: 'hidden' }))).toBe('/');
  });
  test.each([{}, [], () => 'x'].map(value => ({ value })))('rejects nonscalar interpolation', ({ value }) => {
    expect(() => render('\n  {{value}}', { value })).toThrow(/Cannot interpolate .*scalar text at line 2, column 3/);
    expect(() => render('{{{value}}}', { value })).toThrow('Cannot interpolate');
  });
});

describe('blocks', () => {
  test.each(['', 0, false, null, undefined, []].map(value => ({ value })))('treats empty values as false', ({ value }) => {
    expect(render('{{#if value}}yes{{else}}no{{/if}}', { value })).toBe('no');
  });
  test.each(['0', 1, true, {}, [0]].map(value => ({ value })))('treats other values as true', ({ value }) => {
    expect(render('{{#if value}}yes{{else}}no{{/if}}', { value })).toBe('yes');
  });
  test('nests conditionals and allows omitted else', () => {
    expect(render('{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}{{#if missing}}X{{/if}}', { a: true, b: false })).toBe('AC');
  });
  test('iterates scalars, uses item fields and falls back to root', () => {
    expect(render('{{#each values}}{{@index}}={{this}}/{{title}};{{/each}}', { values: ['a', 'b'], title: 'T' })).toBe('0=a/T;1=b/T;');
    expect(render('{{#each values}}{{name}}/{{this.name}}/{{x.y}};{{/each}}', { name: 'root', x: { y: 'Y' }, values: [{ name: 'local' }, { name: null }] })).toBe('local/local/Y;//Y;');
  });
  test('nested loops restore outer context and keep root fallback', () => {
    const template = '{{#each groups}}{{@index}}:{{name}}[{{#each items}}{{@index}}={{this}}/{{title}};{{else}}empty:{{name}}{{/each}}]{{@index}}:{{name}}|{{/each}}';
    expect(render(template, { title: 'T', groups: [{ name: 'A', items: ['x', 'y'] }, { name: 'B', items: [] }] })).toBe('0:A[0=x/T;1=y/T;]0:A|1:B[empty:B]1:B|');
  });
  test.each([[], null, undefined, {}, 'abc', 7].map(values => ({ values })))('selects each else for nonarrays and empty arrays', ({ values }) => {
    expect(render('{{#each values}}X{{else}}empty{{/each}}', { values })).toBe('empty');
  });
});

describe('syntax errors', () => {
  test.each([
    ['{{#unknown x}}', 'Unknown block'],
    ['{{/if}}', 'Unexpected closing tag'],
    ['{{#if x}}{{/each}}', 'Mismatched closing tag'],
    ['{{#each x}}', 'Unclosed each block'],
    ['{{#if x}}{{else}}{{else}}{{/if}}', 'Duplicate else'],
    ['{{else}}', 'else outside a block'],
    ['{{value', 'Unclosed tag'],
    ['{{#if}}', 'Invalid path'],
  ])('rejects %s', (template, message) => {
    expect(() => render(template, {})).toThrow(message);
    expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
  });
  test('reports exact multiline locations and checks inactive branches', () => {
    expect(() => render('hello\n  {{else}}', {})).toThrow('line 2, column 3');
    expect(() => render('{{#if absent}}\n{{#bad x}}{{/if}}', {})).toThrow('Unknown block');
  });
});
