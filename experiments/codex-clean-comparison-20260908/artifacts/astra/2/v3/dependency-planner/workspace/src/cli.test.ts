import { expect, test } from 'bun:test';
import { plan } from './cli';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });
test('empty input', () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});
test('ready queue differs from layers; concurrent timing and disconnected work', () => {
  expect(plan({ tasks: [task('z', 2), task('b', 3, ['a']), task('a', 1), task('c', 4, ['b', 'z'])] })).toEqual({
    order: ['a', 'b', 'z', 'c'], layers: [['a', 'z'], ['b'], ['c']],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, z: { start: 0, finish: 2 }, c: { start: 4, finish: 8 } },
    totalDuration: 8, criticalPath: ['a', 'b', 'c'],
  });
});
test('critical ties compare full paths rather than immediate predecessors', () => {
  expect(plan({ tasks: [task('a'), task('z', 1, ['a']), task('b'), task('c', 1, ['b']), task('end', 1, ['c', 'z'])] }).criticalPath).toEqual(['a', 'z', 'end']);
});
test('zero durations, prefix ties, and chains starting at interior tasks', () => {
  expect(plan({ tasks: [task('a', 0), task('b', 0, ['a'])] }).criticalPath).toEqual(['a']);
  expect(plan({ tasks: [task('z', 0), task('a', 2, ['z']), task('b', 0, ['a'])] }).criticalPath).toEqual(['a']);
  expect(plan({ tasks: [task('a', 0), task('b', 2, ['a'])] }).criticalPath).toEqual(['a', 'b']);
});
test('prototype-like ids and default dependencies', () => {
  const result = plan({ tasks: [{ id: '__proto__', duration: 2 }, task('constructor', 1, ['__proto__'])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 2 });
  expect(result.totalDuration).toBe(3);
});
test('schema validation', () => {
  const invalid = [null, [], {}, { tasks: {} }, { tasks: [null] }, { tasks: [task('')] },
    { tasks: [task('a'), task('a')] }, { tasks: [task('a', -1)] }, { tasks: [task('a', Infinity)] },
    { tasks: [{ id: 'a', duration: '1' }] }, { tasks: [{ id: 'a', duration: 1, dependsOn: null }] },
    { tasks: [{ id: 'a', duration: 1, dependsOn: [1] }] }, { tasks: [task('a', 1, ['x'])] },
    { tasks: [task('a', 1, ['a'])] }, { tasks: [task('a'), task('b', 1, ['a', 'a'])] }];
  for (const input of invalid) expect(() => plan(input)).toThrow();
});
test('deterministic concrete cycle across input permutations', () => {
  const tasks = [task('c', 1, ['b']), task('b', 1, ['a']), task('a', 1, ['c']), task('free')];
  for (const input of [tasks, [...tasks].reverse()]) {
    expect(() => plan({ tasks: input })).toThrow('Cycle detected: a -> b -> c -> a');
  }
});
test('CLI stdout, errors, and exit codes', () => {
  const dir = mkdtempSync(join(process.cwd(), '.test-'));
  const file = join(dir, 'input.json');
  const run = (args: string[]) => Bun.spawnSync([process.execPath, 'run', 'src/cli.ts', ...args], { cwd: process.cwd() });
  try {
    writeFileSync(file, JSON.stringify({ tasks: [task('a', 2)] }));
    const result = run(['plan', file]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe('');
    expect(result.stdout.toString().trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout.toString()).totalDuration).toBe(2);
    for (const args of [[], ['wat', file], ['plan'], ['plan', '--help'], ['plan', file, '--extra'], ['plan', join(dir, 'missing')]]) {
      const failure = run(args);
      expect(failure.exitCode).not.toBe(0);
      expect(failure.stdout.toString()).toBe('');
      expect(failure.stderr.toString().length).toBeGreaterThan(0);
    }
    for (const text of ['{', '{"tasks":false}', JSON.stringify({ tasks: [task('a', 1, ['b']), task('b', 1, ['a'])] })]) {
      writeFileSync(file, text);
      const failure = run(['plan', file]);
      expect(failure.exitCode).not.toBe(0);
      expect(failure.stdout.toString()).toBe('');
      expect(failure.stderr.toString().length).toBeGreaterThan(0);
    }
  } finally { rmSync(dir, { recursive: true }); }
});
