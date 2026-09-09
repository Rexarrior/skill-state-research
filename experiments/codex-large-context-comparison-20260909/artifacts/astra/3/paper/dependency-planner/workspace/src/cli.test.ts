import { expect, test } from 'bun:test';
import { plan } from './cli';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });
test('scheduling, newly ready ordering, layers, and disconnected components', () => {
  expect(plan({ tasks: [task('z', 2), task('b', 3, ['a']), task('a', 1), task('c', 2, ['a']), task('d', 1, ['b', 'c'])] })).toEqual({
    order: ['a', 'b', 'c', 'd', 'z'], layers: [['a', 'z'], ['b', 'c'], ['d']],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, c: { start: 1, finish: 3 }, d: { start: 4, finish: 5 }, z: { start: 0, finish: 2 } },
    totalDuration: 5, criticalPath: ['a', 'b', 'd'],
  });
});
test('empty graph and default dependencies', () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  expect(plan({ tasks: [{ id: 'a', duration: 0 }] }).criticalPath).toEqual(['a']);
});
test('full-sequence critical ties and zero-duration prefixes/extensions', () => {
  expect(plan({ tasks: [task('a'), task('b', 0, ['a']), task('c', 1, ['a', 'b']), task('d', 0, ['c'])] }).criticalPath).toEqual(['a', 'b', 'c']);
  expect(plan({ tasks: [task('z', 0), task('a', 1, ['z'])] }).criticalPath).toEqual(['a']);
  expect(plan({ tasks: [task('a', 0), task('b', 1, ['a']), task('c', 1)] }).criticalPath).toEqual(['a', 'b']);
});
test('special object keys remain ordinary ids', () => {
  const result = plan({ tasks: [task('__proto__'), task('constructor', 2, ['__proto__'])] });
  expect(Object.hasOwn(result.earliest, '__proto__')).toBe(true);
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 1 });
});
test('schema validation', () => {
  for (const input of [null, [], {}, { tasks: {} }, { tasks: [null] }, { tasks: [task('')] }, { tasks: [task('a'), task('a')] }, ...[-1, Infinity, NaN, '1', null].map(duration => ({ tasks: [{ id: 'a', duration }] })), ...[null, {}, [1], ['a'], ['b'], ['b', 'b']].map(dependsOn => ({ tasks: [{ id: 'a', duration: 1, dependsOn }] }))]) {
    expect(() => plan(input)).toThrow();
  }
});
test('cycle reporting is concrete and independent of input order', () => {
  const tasks = [task('c', 1, ['a']), task('b', 1, ['c']), task('a', 1, ['b'])];
  expect(() => plan({ tasks })).toThrow('a -> b -> c -> a');
  expect(() => plan({ tasks: tasks.reverse() })).toThrow('a -> b -> c -> a');
});
test('critical path matches exhaustive chain enumeration on seeded random DAGs', () => {
  let seed = 731;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const comparePaths = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  };
  for (let iteration = 0; iteration < 200; iteration++) {
    const ids = ['g', 'a', 'f', 'b', 'e', 'c', 'd'];
    const tasks = ids.map((id, i) => task(id, Math.floor(random() * 3), ids.slice(0, i).filter(() => random() < 0.4)));
    const chains: { path: string[]; sum: number }[] = [];
    function visit(path: string[], sum: number) {
      chains.push({ path, sum });
      for (const next of tasks.filter(t => t.dependsOn.includes(path[path.length - 1]))) visit([...path, next.id], sum + next.duration);
    }
    for (const t of tasks) visit([t.id], t.duration);
    chains.sort((a, b) => b.sum - a.sum || comparePaths(a.path, b.path));
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(chains[0].sum);
    expect(result.criticalPath).toEqual(chains[0].path);
    expect(plan({ tasks: [...tasks].reverse() })).toEqual(result);
  }
});
test('CLI emits one JSON object and fails cleanly', () => {
  const dir = mkdtempSync(join(process.cwd(), '.cli-test-'));
  const file = join(dir, 'input.json');
  const run = (args: string[]) => Bun.spawnSync([process.execPath, 'run', join(import.meta.dir, 'cli.ts'), ...args]);
  try {
    writeFileSync(file, JSON.stringify({ tasks: [task('a')] }));
    const ok = run(['plan', file]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stderr.toString()).toBe('');
    expect(ok.stdout.toString().trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(ok.stdout.toString()).order).toEqual(['a']);
    for (const args of [[], ['other', file], ['plan', file, '--bad'], ['plan', '--bad'], ['plan', join(dir, 'missing')]]) {
      const result = run(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString().length).toBeGreaterThan(0);
      expect(result.stdout.toString()).toBe('');
    }
    for (const text of ['{', '{"tasks":null}', JSON.stringify({ tasks: [task('a', 1, ['b']), task('b', 1, ['a'])] })]) {
      writeFileSync(file, text);
      const result = run(['plan', file]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString().length).toBeGreaterThan(0);
      expect(result.stdout.toString()).toBe('');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
