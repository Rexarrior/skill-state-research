import { describe, expect, test, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { plan } from '../src/cli';

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });
const directory = mkdtempSync(join(import.meta.dir, '.fixtures-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const cli = (...args: string[]) => Bun.spawnSync([process.execPath, 'run', 'src/cli.ts', ...args], { cwd: join(import.meta.dir, '..') });

test('order selects newly ready tasks before already ready larger ids', () => {
  expect(plan({ tasks: [task('z', 2), task('b', 3, ['a']), task('a', 1)] })).toEqual({
    order: ['a', 'b', 'z'], layers: [['a', 'z'], ['b']],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, z: { start: 0, finish: 2 } },
    totalDuration: 4, criticalPath: ['a', 'b'],
  });
});

test('empty input and special object keys', () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  const result = plan({ tasks: [task('__proto__'), task('constructor', 2, ['__proto__'])] });
  expect(result.earliest['__proto__']).toEqual({ start: 0, finish: 1 });
  expect(JSON.parse(JSON.stringify(result)).earliest.constructor).toEqual({ start: 1, finish: 3 });
});

test('full sequence ties and zero-duration prefixes', () => {
  expect(plan({ tasks: [task('a', 0), task('b', 1, ['a']), task('z', 2, ['a', 'b'])] }).criticalPath).toEqual(['a', 'b', 'z']);
  expect(plan({ tasks: [task('a', 1), task('b', 0, ['a'])] }).criticalPath).toEqual(['a']);
  expect(plan({ tasks: [task('z', 0), task('a', 0, ['z'])] }).criticalPath).toEqual(['a']);
});

describe('validation', () => {
  const invalid = [null, [], {}, { tasks: {} }, { tasks: [null] }, { tasks: [task('')] },
    { tasks: [task('a'), task('a')] }, { tasks: [task('a', -1)] }, { tasks: [task('a', Infinity)] },
    { tasks: [task('a', NaN)] }, { tasks: [{ id: 'a', duration: '1' }] },
    { tasks: [{ id: 'a', duration: 1, dependsOn: null }] },
    { tasks: [{ id: 'a', duration: 1, dependsOn: [3] }] },
    { tasks: [task('a', 1, ['b'])] }, { tasks: [task('a', 1, ['a'])] },
    { tasks: [task('a'), task('b', 1, ['a', 'a'])] }];
  for (const [i, value] of invalid.entries()) test(`rejects invalid schema ${i}`, () => expect(() => plan(value)).toThrow());
  test('omitted dependencies default to empty', () => expect(plan({ tasks: [{ id: 'a', duration: 0.5 }] }).totalDuration).toBe(0.5));
});

test('cycle diagnostics are concrete and input-order independent', () => {
  const tasks = [task('c', 1, ['a']), task('b', 1, ['c']), task('a', 1, ['b']), task('free')];
  for (const list of [tasks, [...tasks].reverse()]) expect(() => plan({ tasks: list })).toThrow('a -> b -> c -> a');
});

test('CLI emits exactly one object or a useful stderr failure', () => {
  const file = join(directory, 'input.json');
  writeFileSync(file, JSON.stringify({ tasks: [task('a')] }));
  const success = cli('plan', file);
  expect(success.exitCode).toBe(0);
  expect(success.stderr.toString()).toBe('');
  expect(success.stdout.toString().trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(success.stdout.toString()).criticalPath).toEqual(['a']);
  for (const args of [[], ['unknown'], ['plan'], ['plan', file, '--wat'], ['plan', '--wat'], ['plan', file, file], ['plan', join(directory, 'missing')]]) {
    const result = cli(...args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString().length).toBeGreaterThan(0);
  }
  for (const text of ['{', '{"tasks":false}', JSON.stringify({ tasks: [task('a', 1, ['b']), task('b', 1, ['a'])] })]) {
    writeFileSync(file, text);
    const result = cli('plan', file);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toMatch(/JSON|tasks|a -> b -> a/);
  }
});

test('exhaustive four-node DAGs agree with independent chain enumeration', () => {
  const ids = ['d', 'b', 'a', 'c'];
  const edges = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  const comparePath = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let mask = 0; mask < 64; mask++) for (let durations = 0; durations < 16; durations++) {
    const tasks = ids.map((id, i) => task(id, (durations >> i) & 1,
      edges.filter(([from, to], bit) => to === i && (mask & (1 << bit))).map(([from]) => ids[from])));
    const chains: { path: string[]; sum: number }[] = [];
    const walk = (index: number, path: string[], sum: number) => {
      const next = [...path, ids[index]];
      const total = sum + tasks[index].duration;
      chains.push({ path: next, sum: total });
      for (let child = 0; child < tasks.length; child++) if (tasks[child].dependsOn.includes(ids[index])) walk(child, next, total);
    };
    for (let i = 0; i < tasks.length; i++) walk(i, [], 0);
    const total = Math.max(...chains.map(chain => chain.sum));
    const path = chains.filter(chain => chain.sum === total).map(chain => chain.path).sort(comparePath)[0];
    const result = plan({ tasks: [...tasks].reverse() });
    expect(result.totalDuration).toBe(total);
    expect(result.criticalPath).toEqual(path);
    const pending = new Set(ids);
    const completed = new Set<string>();
    for (const id of result.order) {
      const ready = tasks.filter(t => pending.has(t.id) && t.dependsOn.every(dep => completed.has(dep))).map(t => t.id).sort();
      expect(id).toBe(ready[0]);
      pending.delete(id);
      completed.add(id);
    }
    for (const t of tasks) {
      expect(result.earliest[t.id].finish).toBe(Math.max(...chains.filter(chain => chain.path.at(-1) === t.id).map(chain => chain.sum)));
      const level = result.layers.findIndex(layer => layer.includes(t.id));
      expect(level).toBe(t.dependsOn.length ? 1 + Math.max(...t.dependsOn.map(dep => result.layers.findIndex(layer => layer.includes(dep)))) : 0);
    }
  }
});
