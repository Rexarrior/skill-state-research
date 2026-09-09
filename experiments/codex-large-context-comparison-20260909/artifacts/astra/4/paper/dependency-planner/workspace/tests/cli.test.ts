import { test, expect } from 'bun:test';
import { plan } from '../src/cli';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });
test('schedule, disconnected components and lexicographic ready choice', () => {
  expect(plan({ tasks: [task('z'), task('b', 3, ['a']), task('a', 2), task('c', 4, ['a']), task('d', 1, ['b', 'c'])] })).toEqual({
    order: ['a', 'b', 'c', 'd', 'z'], layers: [['a', 'z'], ['b', 'c'], ['d']],
    earliest: { a: { start: 0, finish: 2 }, b: { start: 2, finish: 5 }, c: { start: 2, finish: 6 }, d: { start: 6, finish: 7 }, z: { start: 0, finish: 1 } },
    totalDuration: 7, criticalPath: ['a', 'c', 'd'],
  });
});
test('empty, defaults and special object keys', () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  const result = plan({ tasks: [{ id: '__proto__', duration: 2 }, task('constructor', 1, ['__proto__'])] });
  expect(result.earliest.__proto__).toEqual({ start: 0, finish: 2 });
  expect(result.criticalPath).toEqual(['__proto__', 'constructor']);
});
test('zero-duration prefixes and shorter full-sequence ties', () => {
  expect(plan({ tasks: [task('b', 2), task('a', 0), task('c', 2, ['a'])] }).criticalPath).toEqual(['a', 'c']);
  expect(plan({ tasks: [task('a', 2), task('b', 0, ['a'])] }).criticalPath).toEqual(['a']);
  expect(plan({ tasks: [task('z', 0), task('a', 0, ['z'])] }).criticalPath).toEqual(['a']);
  expect(plan({ tasks: [task('a'), task('c', 1, ['a']), task('b', 1, ['a'])] }).criticalPath).toEqual(['a', 'b']);
});
test('schema failures', () => {
  for (const input of [null, {}, { tasks: {} }, { tasks: [null] }, { tasks: [task('')] }, { tasks: [task('x'), task('x')] }, { tasks: [task('x', -1)] }, { tasks: [task('x', Infinity)] }, { tasks: [task('x', NaN)] }, { tasks: [task('x', 1, ['missing'])] }, { tasks: [task('x', 1, ['x'])] }, { tasks: [task('x'), task('y', 1, ['x', 'x'])] }, { tasks: [{ id: 'x', duration: '1' }] }, { tasks: [{ id: 'x', duration: 1, dependsOn: null }] }, { tasks: [{ id: 'x', duration: 1, dependsOn: [5] }] }]) expect(() => plan(input)).toThrow();
});
test('cycle is concrete and independent of input order', () => {
  const tasks = [task('b', 1, ['a']), task('a', 1, ['b']), task('z')];
  expect(() => plan({ tasks })).toThrow('a -> b -> a');
  expect(() => plan({ tasks: tasks.reverse() })).toThrow('a -> b -> a');
});
test('CLI output and failures', () => {
  const dir = mkdtempSync(join(process.cwd(), '.test-'));
  try {
    const file = join(dir, 'input.json');
    const run = (args: string[]) => Bun.spawnSync([process.execPath, 'run', 'src/cli.ts', ...args]);
    writeFileSync(file, '{"tasks":[]}');
    const ok = run(['plan', file]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stderr.toString()).toBe('');
    expect(JSON.parse(ok.stdout.toString()).totalDuration).toBe(0);
    expect(ok.stdout.toString().trim().split('\n')).toHaveLength(1);
    for (const args of [[], ['other', file], ['plan', file, '--extra'], ['plan', '--flag'], ['plan', join(dir, 'missing')]]) {
      const result = run(args); expect(result.exitCode).not.toBe(0); expect(result.stderr.length).toBeGreaterThan(0); expect(result.stdout.length).toBe(0);
    }
    for (const text of ['{', '{"tasks":[{"id":"a","duration":1,"dependsOn":["b"]},{"id":"b","duration":1,"dependsOn":["a"]}]}']) {
      writeFileSync(file, text);
      const result = run(['plan', file]); expect(result.exitCode).not.toBe(0); expect(result.stderr.length).toBeGreaterThan(0); expect(result.stdout.length).toBe(0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
