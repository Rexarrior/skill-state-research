import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const cli = join(import.meta.dir, '../src/cli.ts');
function run(input: unknown, args?: string[], raw = false) {
  const dir = mkdtempSync(join(import.meta.dir, '.case-'));
  try {
    const file = join(dir, 'input.json');
    writeFileSync(file, raw ? String(input) : JSON.stringify(input));
    const result = Bun.spawnSync([process.execPath, 'run', cli, ...(args ?? ['plan', file])]);
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });
function good(tasks: unknown[]) {
  const result = run({ tasks });
  expect(result.code).toBe(0); expect(result.err).toBe('');
  expect(result.out.trim().split('\n')).toHaveLength(1);
  return JSON.parse(result.out);
}
test('empty graph', () => {
  expect(good([])).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});
test('ready priority, layers and parallel schedule', () => {
  expect(good([task('z', 2), task('b', 3), task('a', 4, ['b']), task('c', 1, ['a', 'z'])])).toEqual({
    order: ['b', 'a', 'z', 'c'], layers: [['b', 'z'], ['a'], ['c']],
    earliest: { b: { start: 0, finish: 3 }, a: { start: 3, finish: 7 }, z: { start: 0, finish: 2 }, c: { start: 7, finish: 8 } },
    totalDuration: 8, criticalPath: ['b', 'a', 'c'],
  });
});
test('full sequence tie breaks, zero durations, special ids and defaults', () => {
  expect(good([task('a', 0), task('b', 2, ['a']), task('c', 2), task('d', 0, ['b'])]).criticalPath).toEqual(['a', 'b']);
  expect(good([task('z', 0), task('a', 0, ['z'])]).criticalPath).toEqual(['a']);
  expect(good([{ id: '__proto__', duration: 2 }, task('constructor', 1, ['__proto__'])]).totalDuration).toBe(3);
  expect(good([task('a'), task('z', 1, ['a']), task('b'), task('c', 1, ['b'])]).criticalPath).toEqual(['a', 'z']);
  expect(good([task('a', 0.1), task('b', 0.2, ['a']), task('c', 0.3, ['b'])]).criticalPath).toEqual(['a', 'b', 'c']);
});
test('invalid schemas', () => {
  for (const input of [null, {}, { tasks: null }, { tasks: [null] }, { tasks: [task('')] },
    { tasks: [task('a'), task('a')] }, { tasks: [task('a', -1)] }, { tasks: [{ id: 'a', duration: '1' }] },
    { tasks: [task('a', 1, ['missing'])] }, { tasks: [task('a', 1, ['a'])] },
    { tasks: [task('a'), task('b', 1, ['a', 'a'])] }, { tasks: [{ id: 'a', duration: 1, dependsOn: null }] },
    { tasks: [{ id: 'a', duration: 1, dependsOn: [3] }] }]) {
    const result = run(input); expect(result.code).not.toBe(0); expect(result.out).toBe(''); expect(result.err.length).toBeGreaterThan(0);
  }
  expect(run('{', undefined, true).err).toContain('Invalid JSON');
  expect(run('{"tasks":[{"id":"a","duration":1e999}]}', undefined, true).code).not.toBe(0);
});
test('CLI errors and deterministic cycle', () => {
  for (const args of [[], ['other'], ['plan', '--help'], ['plan', 'x', '--extra'], ['plan', '/nonexistent/input.json']])
    expect(run({}, args).code).not.toBe(0);
  const tasks = [task('b', 1, ['a']), task('a', 1, ['b']), task('z')];
  const first = run({ tasks }); const second = run({ tasks: tasks.reverse() });
  expect(first.code).not.toBe(0); expect(first.out).toBe('');
  expect(first.err).toContain('a -> b -> a'); expect(first.err).toBe(second.err);
});
test('exhaustive chain oracle on seeded random DAGs', () => {
  let seed = 19;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const cmp = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  };
  for (let n = 0; n < 25; n++) {
    const ids = ['f', 'a', 'd', 'b', 'e', 'c'];
    const tasks = ids.map((id, i) => task(id, Math.floor(rand() * 4), ids.slice(0, i).filter(() => rand() < .35)));
    let best = -1; let path: string[] = [];
    const visit = (chain: string[], duration: number) => {
      if (duration > best || duration === best && cmp(chain, path) < 0) { best = duration; path = chain; }
      for (const t of tasks) if (t.dependsOn.includes(chain[chain.length - 1])) visit([...chain, t.id], duration + t.duration);
    };
    for (const t of tasks) visit([t.id], t.duration);
    const result = good(tasks);
    expect(result.totalDuration).toBe(best); expect(result.criticalPath).toEqual(path);
    expect(good([...tasks].reverse())).toEqual(result);
  }
});
