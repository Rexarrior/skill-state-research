import { test, expect } from 'bun:test';
import { plan } from '../src/cli';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });
test('empty plan', () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});
test('lexicographic readiness, parallel layers and timings', () => {
  expect(plan({ tasks: [task('z', 2), task('b', 3, ['a']), task('a', 1), task('c', 4, ['b', 'z'])] })).toEqual({
    order: ['a', 'b', 'z', 'c'], layers: [['a', 'z'], ['b'], ['c']],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, z: { start: 0, finish: 2 }, c: { start: 4, finish: 8 } },
    totalDuration: 8, criticalPath: ['a', 'b', 'c'],
  });
});
test('full-sequence critical ties and zero durations', () => {
  expect(plan({ tasks: [task('a', 0), task('b', 0, ['a']), task('z', 3, ['a', 'b'])] }).criticalPath).toEqual(['a', 'b', 'z']);
  expect(plan({ tasks: [task('z', 0), task('a', 0, ['z'])] }).criticalPath).toEqual(['a']);
  expect(plan({ tasks: [task('a', 2), task('b', 0, ['a'])] }).criticalPath).toEqual(['a']);
});
test('special object keys and default dependencies', () => {
  const result = plan({ tasks: [{ id: '__proto__', duration: 2 }, task('constructor', 1, ['__proto__'])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 2 });
  expect(result.totalDuration).toBe(3);
});
test('schema validation', () => {
  for (const input of [null, [], {}, { tasks: null }, { tasks: [null] }, { tasks: [task('')] },
    { tasks: [task('a'), task('a')] }, { tasks: [task('a', -1)] }, { tasks: [task('a', Infinity)] },
    { tasks: [task('a', NaN)] }, { tasks: [{ id: 'a', duration: '1' }] },
    { tasks: [{ id: 'a', duration: 1, dependsOn: null }] },
    { tasks: [{ id: 'a', duration: 1, dependsOn: [1] }] },
    { tasks: [task('a', 1, ['b'])] }, { tasks: [task('a', 1, ['a'])] },
    { tasks: [task('a'), task('b', 1, ['a', 'a'])] }]) expect(() => plan(input)).toThrow();
});
test('concrete deterministic cycles', () => {
  const tasks = [task('c', 1, ['b']), task('b', 1, ['a']), task('a', 1, ['c']), task('free')];
  for (const list of [tasks, [...tasks].reverse()]) expect(() => plan({ tasks: list })).toThrow('a -> c -> b -> a');
});
test('CLI success and errors', () => {
  const dir = mkdtempSync(join(process.cwd(), '.test-'));
  const file = join(dir, 'input.json');
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, 'run', 'src/cli.ts', ...args]);
  try {
    writeFileSync(file, JSON.stringify({ tasks: [task('a')] }));
    const good = run('plan', file);
    expect(good.exitCode).toBe(0);
    expect(good.stderr.toString()).toBe('');
    expect(good.stdout.toString().trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(good.stdout.toString()).totalDuration).toBe(1);
    for (const args of [[], ['other', file], ['plan', file, '--bad'], ['plan', '--bad'], ['plan', join(dir, 'missing')]]) {
      const bad = run(...args); expect(bad.exitCode).not.toBe(0); expect(bad.stdout.length).toBe(0); expect(bad.stderr.length).toBeGreaterThan(0);
    }
    for (const text of ['{', '{}', JSON.stringify({ tasks: [task('a', 1, ['b']), task('b', 1, ['a'])] })]) {
      writeFileSync(file, text);
      const bad = run('plan', file); expect(bad.exitCode).not.toBe(0); expect(bad.stdout.length).toBe(0); expect(bad.stderr.length).toBeGreaterThan(0);
    }
  } finally { rmSync(dir, { recursive: true }); }
});
test('exhaustive small DAGs agree with enumerated chains', () => {
  const ids = ['c', 'a', 'd', 'b'];
  const cmp = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  };
  for (let edges = 0; edges < 64; edges++) for (let durations = 0; durations < 16; durations++) {
    let bit = 0;
    const tasks = ids.map((id, i) => task(id, (durations >> i) & 1,
      ids.slice(0, i).filter(() => (edges >> bit++) & 1)));
    const chains: { path: string[]; sum: number }[] = [];
    const visit = (i: number, path: string[], sum: number) => {
      const next = [...path, ids[i]], value = sum + tasks[i].duration;
      chains.push({ path: next, sum: value });
      for (let j = i + 1; j < 4; j++) if (tasks[j].dependsOn.includes(ids[i])) visit(j, next, value);
    };
    for (let i = 0; i < 4; i++) visit(i, [], 0);
    chains.sort((a, b) => b.sum - a.sum || cmp(a.path, b.path));
    const result = plan({ tasks: [...tasks].reverse() });
    expect(result.totalDuration).toBe(chains[0].sum);
    expect(result.criticalPath).toEqual(chains[0].path);
  }
});
test('deep graph avoids recursion limits', () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => task(String(i), 1, i ? [String(i - 1)] : []));
  expect(plan({ tasks }).totalDuration).toBe(12000);
  tasks[0].dependsOn = ['11999'];
  expect(() => plan({ tasks })).toThrow('Cycle detected');
});
