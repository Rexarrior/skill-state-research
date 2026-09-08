import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { plan } from '../src/cli';

const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

test('empty graph', () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
});

test('ready queue, layers, disconnected components and parallel timings', () => {
  const result = plan({ tasks: [task('z', 1), task('b', 3, ['a']), task('c', 2), task('d', 4, ['b', 'c']), task('a', 2)] });
  expect(result).toEqual({
    order: ['a', 'b', 'c', 'd', 'z'], layers: [['a', 'c', 'z'], ['b'], ['d']],
    earliest: { a: { start: 0, finish: 2 }, b: { start: 2, finish: 5 }, c: { start: 0, finish: 2 }, d: { start: 5, finish: 9 }, z: { start: 0, finish: 1 } },
    totalDuration: 9, criticalPath: ['a', 'b', 'd'],
  });
});

test('defaults, fractional durations, and special object keys', () => {
  const result = plan({ tasks: [{ id: '__proto__', duration: 0.5 }, task('constructor', 0.25, ['__proto__'])] });
  expect(result.totalDuration).toBe(0.75);
  expect(JSON.parse(JSON.stringify(result.earliest))['__proto__']).toEqual({ start: 0, finish: 0.5 });
});

test('full sequence ties and zero-duration prefixes and suffixes', () => {
  expect(plan({ tasks: [task('a'), task('z', 1, ['a']), task('b'), task('c', 1, ['b'])] }).criticalPath).toEqual(['a', 'z']);
  expect(plan({ tasks: [task('a'), task('b', 0, ['a']), task('z', 1, ['a', 'b'])] }).criticalPath).toEqual(['a', 'b', 'z']);
  expect(plan({ tasks: [task('z', 0), task('a', 1, ['z']), task('b', 0, ['a'])] }).criticalPath).toEqual(['a']);
  expect(plan({ tasks: [task('z', 0), task('a', 0, ['z'])] }).criticalPath).toEqual(['a']);
});

describe('invalid schema', () => {
  const invalid = [null, [], {}, { tasks: null }, { tasks: [null] }, { tasks: [[]] },
    { tasks: [task('')] }, { tasks: [task('a'), task('a')] },
    ...[-1, Infinity, NaN, '1', null].map(duration => ({ tasks: [{ id: 'a', duration }] })),
    ...[null, 'a', [1], ['b', 'b'], ['missing'], ['a']].map(dependsOn => ({ tasks: [{ id: 'a', duration: 1, dependsOn }] })),
  ];
  for (const [index, input] of invalid.entries()) test(`rejects case ${index}`, () => expect(() => plan(input)).toThrow());
});

test('deterministic concrete cycle across input permutations', () => {
  const tasks = [task('c', 1, ['b']), task('a', 1, ['c']), task('b', 1, ['a']), task('free')];
  expect(() => plan({ tasks })).toThrow('Cycle detected: a -> b -> c -> a');
  expect(() => plan({ tasks: tasks.reverse() })).toThrow('Cycle detected: a -> b -> c -> a');
});

test('long chains avoid recursive stack limits', () => {
  const tasks = Array.from({ length: 15000 }, (_, i) => task(`t${i}`, 1, i ? [`t${i - 1}`] : []));
  expect(plan({ tasks }).criticalPath.length).toBe(tasks.length);
  tasks[0].dependsOn.push('t14999');
  expect(() => plan({ tasks })).toThrow('Cycle detected:');
});

test('seeded DAGs agree with exhaustive chain oracle and are input-order independent', () => {
  let seed = 718;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const comparePaths = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let iteration = 0; iteration < 200; iteration++) {
    const ids = ['f', 'a', 'e', 'b', 'd', 'c'];
    const tasks = ids.map((id, i) => task(id, Math.floor(random() * 3), ids.slice(0, i).filter(() => random() < 0.4)));
    const chains: { ids: string[]; duration: number }[] = [];
    const visit = (chain: string[], duration: number) => {
      chains.push({ ids: chain, duration });
      for (const child of tasks.filter(t => t.dependsOn.includes(chain.at(-1)!))) visit([...chain, child.id], duration + child.duration);
    };
    for (const t of tasks) visit([t.id], t.duration);
    chains.sort((a, b) => b.duration - a.duration || comparePaths(a.ids, b.ids));
    const result = plan({ tasks });
    expect(result.totalDuration).toBe(chains[0].duration);
    expect(result.criticalPath).toEqual(chains[0].ids);
    expect(plan({ tasks: [...tasks].reverse().map(t => ({ ...t, dependsOn: [...t.dependsOn].reverse() })) })).toEqual(result);
  }
});

test('CLI JSON output and failure diagnostics', () => {
  const directory = mkdtempSync(join(process.cwd(), '.cli-test-'));
  const input = join(directory, 'input.json');
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, 'run', 'src/cli.ts', ...args], { cwd: process.cwd() });
  try {
    writeFileSync(input, JSON.stringify({ tasks: [task('a')] }));
    const success = run('plan', input);
    expect(success.exitCode).toBe(0);
    expect(success.stderr.toString()).toBe('');
    expect(success.stdout.toString().trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(success.stdout.toString())).toEqual(plan({ tasks: [task('a')] }));
    for (const args of [[], ['other', input], ['plan'], ['plan', '--help'], ['plan', input, '--unknown'], ['plan', join(directory, 'absent.json')]]) {
      const failure = run(...args);
      expect(failure.exitCode).not.toBe(0);
      expect(failure.stdout.toString()).toBe('');
      expect(failure.stderr.toString().length).toBeGreaterThan(0);
    }
    for (const text of ['{', '{}', '{"tasks":[{"id":"a","duration":1e999}]}', JSON.stringify({ tasks: [task('a', 1, ['b']), task('b', 1, ['a'])] })]) {
      writeFileSync(input, text);
      const failure = run('plan', input);
      expect(failure.exitCode).not.toBe(0);
      expect(failure.stdout.toString()).toBe('');
      expect(failure.stderr.toString()).toMatch(/JSON|tasks|duration|a -> b -> a/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
