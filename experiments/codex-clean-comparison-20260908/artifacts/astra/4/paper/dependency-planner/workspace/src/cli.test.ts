import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { plan } from './cli';

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });
test('diamond, disconnected tasks, earliest layers, and ready priority', () => {
  expect(plan({ tasks: [task('z', 2), task('c', 3, ['a', 'b']), task('a', 1), task('b', 2, ['a'])] })).toEqual({
    order: ['a', 'b', 'c', 'z'], layers: [['a', 'z'], ['b'], ['c']],
    earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 3 }, c: { start: 3, finish: 6 }, z: { start: 0, finish: 2 } },
    totalDuration: 6, criticalPath: ['a', 'b', 'c'],
  });
});
test('empty, defaults, special object keys, and fractional times', () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  const result = plan({ tasks: [{ id: '__proto__', duration: 0.5 }, task('constructor', 0.25, ['__proto__'])] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 0.5 });
  expect(result.totalDuration).toBe(0.75);
});
test('critical path compares full sequences and handles zero prefixes and endings', () => {
  expect(plan({ tasks: [task('a', 0), task('b', 0, ['a']), task('z', 2, ['a', 'b']), task('end', 0, ['z'])] }).criticalPath).toEqual(['a', 'b', 'z']);
  expect(plan({ tasks: [task('z', 0), task('a', 0, ['z'])] }).criticalPath).toEqual(['a']);
  expect(plan({ tasks: [task('a'), task('z', 1, ['a']), task('b'), task('c', 1, ['b'])] }).criticalPath).toEqual(['a', 'z']);
});
test('schema errors', () => {
  const invalid = [null, [], {}, { tasks: {} }, { tasks: [null] }, { tasks: [task('')] },
    { tasks: [task('a'), task('a')] }, { tasks: [task('a', -1)] }, { tasks: [task('a', Infinity)] },
    { tasks: [task('a', NaN)] }, { tasks: [{ id: 'a', duration: '1' }] },
    { tasks: [{ id: 'a', duration: 1, dependsOn: null }] },
    { tasks: [{ id: 'a', duration: 1, dependsOn: [1] }] },
    { tasks: [task('a', 1, ['b'])] }, { tasks: [task('a', 1, ['a'])] },
    { tasks: [task('a'), task('b', 1, ['a', 'a'])] }];
  for (const value of invalid) expect(() => plan(value)).toThrow();
});
test('cycle diagnostics are concrete and independent of input order', () => {
  const tasks = [task('c', 1, ['b']), task('a', 1, ['c']), task('b', 1, ['a']), task('free')];
  for (const input of [tasks, [...tasks].reverse()]) expect(() => plan({ tasks: input })).toThrow('a -> b -> c -> a');
});
test('long chains avoid recursion limits', () => {
  const tasks = Array.from({ length: 12000 }, (_, i) => task(String(i), 1, i ? [String(i - 1)] : []));
  expect(plan({ tasks }).totalDuration).toBe(12000);
  tasks[0]!.dependsOn.push('11999');
  expect(() => plan({ tasks })).toThrow('Cycle detected:');
});
test('random small DAGs agree with exhaustive chain enumeration', () => {
  let seed = 17;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const cmp = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    return a.length - b.length;
  };
  for (let round = 0; round < 150; round++) {
    const tasks = ['d', 'b', 'f', 'a', 'e', 'c'].map((id, i, names) => task(id, Math.floor(random() * 3), names.slice(0, i).filter(() => random() < 0.35)));
    let best = -1, path: string[] = [];
    function visit(t: typeof tasks[number], prefix: string[], sum: number) {
      const candidate = [...prefix, t.id];
      const duration = sum + t.duration;
      if (duration > best || (duration === best && cmp(candidate, path) < 0)) { best = duration; path = candidate; }
      for (const child of tasks) if (child.dependsOn.includes(t.id)) visit(child, candidate, duration);
    }
    for (const t of tasks) visit(t, [], 0);
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(best);
    expect(result.criticalPath).toEqual(path);
    expect(plan({ tasks: [...tasks].reverse() })).toEqual(result);
  }
});
test('CLI emits one JSON object and errors only on stderr', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.test-'));
  const cli = join(import.meta.dir, 'cli.ts');
  async function run(args: string[]) {
    const proc = Bun.spawn([process.execPath, 'run', cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }
  try {
    const file = join(dir, 'input.json');
    await writeFile(file, JSON.stringify({ tasks: [task('a')] }));
    const good = await run(['plan', file]);
    expect(good.code).toBe(0);
    expect(good.stderr).toBe('');
    expect(good.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(good.stdout).order).toEqual(['a']);
    for (const args of [[], ['unknown', file], ['plan', file, '--verbose'], ['plan', '--help'], ['plan', join(dir, 'missing')]]) {
      const bad = await run(args);
      expect(bad.code).not.toBe(0); expect(bad.stdout).toBe(''); expect(bad.stderr.length).toBeGreaterThan(0);
    }
    for (const text of ['{', '{"tasks":false}', JSON.stringify({ tasks: [task('a', 1, ['b']), task('b', 1, ['a'])] })]) {
      await writeFile(file, text);
      const bad = await run(['plan', file]);
      expect(bad.code).not.toBe(0); expect(bad.stdout).toBe(''); expect(bad.stderr.length).toBeGreaterThan(0);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
