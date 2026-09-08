import { describe, expect, test } from 'bun:test';
import { render } from '../src/engine';

describe('interpolation', () => {
  test('escapes all HTML characters and supports raw text', () => {
    expect(render('{{x}}|{{{x}}}', { x: '&<>"\'' })).toBe('&amp;&lt;&gt;&quot;&#39;|&<>"\'');
  });
  test('preserves whitespace and removes comments', () => {
    expect(render(' \r\n\t{{! ignored }}{{ x }}\n ', { x: '雪' })).toBe(' \r\n\t雪\n ');
    expect(render('', null)).toBe('');
  });
  test('resolves dotted and numeric paths and missing values', () => {
    expect(render('{{a.0.name}}|{{missing.path}}|{{nil}}|{{zero}}|{{bool}}', {
      a: [{ name: 'Ada' }], nil: null, zero: 0, bool: false,
    })).toBe('Ada|||0|false');
    expect(render('{{this}}/{{@index}}', 'root')).toBe('root/');
  });
  test('does not expose inherited properties', () => {
    expect(render('{{secret}}/{{toString}}', Object.create({ secret: 'hidden' }))).toBe('/');
  });
  for (const value of [{}, [], () => 'bad']) {
    test(`rejects nonscalar ${typeof value}`, () => {
      expect(() => render('line\n  {{value}}', { value })).toThrow(/scalar text.*line 2, column 3/);
      expect(() => render('{{{value}}}', { value })).toThrow(/scalar text/);
    });
  }
});

describe('blocks', () => {
  for (const value of ['', 0, false, null, undefined, []]) {
    test(`false branch for ${String(value)}`, () => {
      expect(render('{{#if value}}yes{{else}}no{{/if}}', { value })).toBe('no');
    });
  }
  for (const value of ['0', 1, true, {}, [0], NaN, 0n]) {
    test(`true branch for ${String(value)}`, () => {
      expect(render('{{#if value}}yes{{else}}no{{/if}}', { value })).toBe('yes');
    });
  }
  test('nested conditions and lazy value evaluation', () => {
    expect(render('{{#if a}}A{{#if b}}B{{else}}C{{/if}}{{else}}D{{/if}}', { a: true, b: false })).toBe('AC');
    expect(render('{{#if missing}}{{object}}{{/if}}', { object: {} })).toBe('');
  });
  test('loops use item paths, root fallback, and explicit this', () => {
    expect(render('{{#each items}}{{@index}}:{{name}}/{{title}}/{{this.name}};{{/each}}', {
      title: 'Root', name: 'Fallback', items: [{ name: 'Ada' }, {}],
    })).toBe('0:Ada/Root/Ada;1:Fallback/Root/;');
    expect(render('{{#each items}}{{name}}|{{/each}}', { name: 'root', items: [{ name: null }, { name: undefined }] })).toBe('||');
    expect(render('{{#each items}}{{this}};{{/each}}', { items: ['a', 2, false, null] })).toBe('a;2;false;;');
  });
  test('nested loops restore context and retain root fallback', () => {
    expect(render('{{#each groups}}{{@index}}/{{name}}[{{#each values}}{{@index}}:{{this}}:{{title}};{{else}}{{name}}:empty{{/each}}]{{@index}}/{{name}}{{/each}}', {
      title: 'T', groups: [{ name: 'A', values: ['x', 'y'] }, { name: 'B', values: [] }],
    })).toBe('0/A[0:x:T;1:y:T;]0/A1/B[B:empty]1/B');
  });
  test('empty and nonarray values use each alternate', () => {
    for (const items of [[], undefined, null, {}, 'abc', 0]) {
      expect(render('{{#each items}}item{{else}}empty{{/each}}', { items })).toBe('empty');
      expect(render('{{#each items}}item{{/each}}', { items })).toBe('');
    }
  });
});

describe('syntax errors', () => {
  const cases: [string, RegExp][] = [
    ['{{#unknown x}}', /Unknown block/],
    ['{{/if}}', /Unexpected closing tag/],
    ['{{#if x}}{{/each}}', /Mismatched closing tag/],
    ['{{#if x}}', /Unclosed if block/],
    ['{{#each x}}', /Unclosed each block/],
    ['{{else}}', /else outside/],
    ['{{#if x}}{{else}}{{else}}{{/if}}', /Duplicate else/],
    ['{{#each x}}{{else}}{{else}}{{/each}}', /Duplicate else/],
    ['{{value', /Unclosed tag/],
    ['{{{value}}', /Unclosed tag/],
    ['{{#if}}', /Invalid path/],
    ['{{a..b}}', /Invalid path/],
  ];
  for (const [template, error] of cases) {
    test(template, () => {
      expect(() => render(template, {})).toThrow(error);
      expect(() => render(template, {})).toThrow(/line \d+, column \d+/);
    });
  }
  test('reports exact tag location and validates skipped branches', () => {
    expect(() => render('hello\n  {{else}}', {})).toThrow('line 2, column 3');
    expect(() => render('{{#if absent}}{{#bad x}}{{/if}}', {})).toThrow(/Unknown block/);
  });
});
