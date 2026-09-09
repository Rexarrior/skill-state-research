import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { plan } from '../src/cli';

test('schedules dependencies and disconnected components', () => {
  expect(plan({ tasks: [
    { id: 'build', duration: 3, dependsOn: ['lint', 'test'] },
    { id: 'test', duration: 4, dependsOn: ['lint'] },
    { id: 'lint', duration: 2 },
    { id: 'docs', duration: 1 },
  ] })).toEqual({
    order: ['docs', 'lint', 'test', 'build'],
    layers: [['docs', 'lint'], ['test'], ['build']],
    earliest: { docs: { start: 0, finish: 1 }, lint: { start: 0, finish: 2 }, test: { start: 2, finish: 6 }, build: { start: 6, finish: 9 } },
    totalDuration: 9, criticalPath: ['lint', 'test', 'build'],
  });
});

test('newly ready tasks compete lexicographically', () => {
  const result = plan({ tasks: [{ id: 'z', duration: 1 }, { id: 'b', duration: 1 }, { id: 'a', duration: 1, dependsOn: ['b'] }] });
  expect(result.order).toEqual(['b', 'a', 'z']);
  expect(result.layers).toEqual([['b', 'z'], ['a']]);
});

test('empty tasks and prototype-like ids', () => {
  expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  const result = plan({ tasks: [{ id: '__proto__', duration: 2 }, { id: 'constructor', duration: 1, dependsOn: ['__proto__'] }] });
  expect(JSON.parse(JSON.stringify(result)).earliest.__proto__).toEqual({ start: 0, finish: 2 });
  expect(result.criticalPath).toEqual(['__proto__', 'constructor']);
});

test('compares full paths and handles zero-duration prefixes and suffixes', () => {
  expect(plan({ tasks: [
    { id: 'a', duration: 0 }, { id: 'b', duration: 1, dependsOn: ['a'] },
    { id: 'c', duration: 1, dependsOn: ['a', 'b'] }, { id: 'd', duration: 0, dependsOn: ['c'] },
  ] }).criticalPath).toEqual(['a', 'b', 'c']);
  expect(plan({ tasks: [{ id: 'z', duration: 0 }, { id: 'a', duration: 0, dependsOn: ['z'] }] }).criticalPath).toEqual(['a']);
});

describe('validation', () => {
  const invalid = [null, [], {}, { tasks: null }, { tasks: [null] },
    ...['', 1, null].map(id => ({ tasks: [{ id, duration: 0 }] })),
    ...[-1, Infinity, NaN, '2', null, undefined].map(duration => ({ tasks: [{ id: 'a', duration }] })),
    ...[null, 'a', [1], ['x'], ['a'], ['x', 'x']].map(dependsOn => ({ tasks: [{ id: 'a', duration: 1, dependsOn }] })),
    { tasks: [{ id: 'a', duration: 1 }, { id: 'a', duration: 2 }] },
  ];
  for (const [i, input] of invalid.entries()) test(`rejects invalid input ${i}`, () => expect(() => plan(input)).toThrow());
});

test('reports deterministic concrete cycles despite input ordering', () => {
  const tasks = [{ id: 'b', duration: 1, dependsOn: ['a'] }, { id: 'a', duration: 1, dependsOn: ['b'] }, { id: 'x', duration: 0 }];
  expect(() => plan({ tasks })).toThrow('Dependency cycle: a -> b -> a');
  expect(() => plan({ tasks: tasks.reverse() })).toThrow('Dependency cycle: a -> b -> a');
});

test('random DAG schedules and critical paths match independent exhaustive oracle', () => {
  let seed = 123456;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const comparePaths = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    }
    return a.length - b.length;
  };
  for (let trial = 0; trial < 300; trial++) {
    const ids = ['c', 'a', 'f', 'b', 'e', 'd'];
    const tasks = ids.map((id, i) => ({ id, duration: Math.floor(random() * 4), dependsOn: ids.slice(0, i).filter(() => random() < 0.4) }));
    const paths: { ids: string[]; duration: number }[] = [];
    const walk = (path: string[], duration: number) => {
      paths.push({ ids: path, duration });
      for (const task of tasks) if (task.dependsOn.includes(path[path.length - 1]!)) walk([...path, task.id], duration + task.duration);
    };
    for (const task of tasks) walk([task.id], task.duration);
    const maximum = Math.max(...paths.map(path => path.duration));
    const best = paths.filter(path => path.duration === maximum).sort((a, b) => comparePaths(a.ids, b.ids))[0]!;
    const result = plan({ tasks: [...tasks].reverse() });
    expect(result.totalDuration).toBe(maximum);
    expect(result.criticalPath).toEqual(best.ids);
    for (const task of tasks) {
      const finish = Math.max(...paths.filter(path => path.ids.at(-1) === task.id).map(path => path.duration));
      expect(result.earliest[task.id]).toEqual({ start: finish - task.duration, finish });
      const level = result.layers.findIndex(layer => layer.includes(task.id));
      expect(level).toBe(task.dependsOn.length ? 1 + Math.max(...task.dependsOn.map(dep => result.layers.findIndex(layer => layer.includes(dep)))) : 0);
    }
    const pending = new Set(ids);
    for (const id of result.order) {
      const ready = tasks.filter(task => pending.has(task.id) && task.dependsOn.every(dep => !pending.has(dep))).map(task => task.id).sort();
      expect(id).toBe(ready[0]!);
      pending.delete(id);
    }
  }
});

test('CLI output, malformed JSON, missing files, schema, cycles, and invalid arguments', () => {
  const dir = mkdtempSync(resolve('.planner-test-'));
  const file = resolve(dir, 'input.json');
  const cli = resolve('src/cli.ts');
  const run = (args: string[]) => {
    const proc = Bun.spawnSync([process.execPath, 'run', cli, ...args]);
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  };
  try {
    writeFileSync(file, '{"tasks":[{"id":"a","duration":2}]}');
    const success = run(['plan', file]);
    expect(success.code).toBe(0);
    expect(success.stderr).toBe('');
    expect(success.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(success.stdout).totalDuration).toBe(2);
    for (const args of [[], ['other', file], ['plan'], ['plan', file, '--verbose'], ['plan', '--help'], ['plan', resolve(dir, 'missing.json')]]) {
      const result = run(args);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    for (const [text, message] of [['{', 'Invalid JSON'], ['{}', 'tasks array'], ['{"tasks":[{"id":"a","duration":1,"dependsOn":["b"]},{"id":"b","duration":0,"dependsOn":["a"]}]}', 'a -> b -> a']]) {
      writeFileSync(file, text!);
      const result = run(['plan', file]);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(message!);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
