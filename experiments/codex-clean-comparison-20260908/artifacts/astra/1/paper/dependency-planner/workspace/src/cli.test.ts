import { describe, expect, test } from 'bun:test';
import { plan } from './cli';
const task = (id: string, duration = 1, dependsOn: string[] = []) => ({ id, duration, dependsOn });

describe('planner', () => {
  test('empty graph', () => {
    expect(plan({ tasks: [] })).toEqual({ order: [], layers: [], earliest: {}, totalDuration: 0, criticalPath: [] });
  });
  test('ready ordering differs from layers, timings and disconnected tasks', () => {
    expect(plan({ tasks: [task('z', 2), task('b', 3, ['a']), task('a', 1), task('c', 4, ['b', 'z'])] })).toEqual({
      order: ['a', 'b', 'z', 'c'], layers: [['a', 'z'], ['b'], ['c']],
      earliest: { a: { start: 0, finish: 1 }, b: { start: 1, finish: 4 }, z: { start: 0, finish: 2 }, c: { start: 4, finish: 8 } },
      totalDuration: 8, criticalPath: ['a', 'b', 'c'],
    });
  });
  test('full path ties and zero duration prefixes', () => {
    expect(plan({ tasks: [task('a', 0), task('b', 1, ['a']), task('z', 1), task('end', 1, ['b', 'z'])] }).criticalPath).toEqual(['a', 'b', 'end']);
    expect(plan({ tasks: [task('a', 0), task('b', 0, ['a']), task('z', 1, ['a', 'b'])] }).criticalPath).toEqual(['a', 'b', 'z']);
    expect(plan({ tasks: [task('z', 0), task('a', 0, ['z'])] }).criticalPath).toEqual(['a']);
    expect(plan({ tasks: [task('a'), task('b', 0, ['a'])] }).criticalPath).toEqual(['a']);
  });
  test('safe special ids and defaults', () => {
    const result = plan({ tasks: [{ id: '__proto__', duration: 2 }, task('constructor', 1, ['__proto__'])] });
    expect(result.earliest.__proto__).toEqual({ start: 0, finish: 2 });
    expect(result.totalDuration).toBe(3);
  });
  test('deterministic concrete cycle', () => {
    const tasks = [task('b', 1, ['a']), task('a', 1, ['b']), task('c')];
    for (const input of [tasks, [...tasks].reverse()]) expect(() => plan({ tasks: input })).toThrow('a -> b -> a');
  });
  test('invalid schemas', () => {
    for (const input of [null, {}, { tasks: {} }, { tasks: [null] }, { tasks: [task('')] },
      { tasks: [task('a'), task('a')] }, { tasks: [task('a', -1)] }, { tasks: [task('a', Infinity)] },
      { tasks: [{ id: 'a', duration: '1' }] }, { tasks: [{ id: 'a', duration: 1, dependsOn: null }] },
      { tasks: [{ id: 'a', duration: 1, dependsOn: [1] }] }, { tasks: [task('a', 1, ['b'])] },
      { tasks: [task('a', 1, ['a'])] }, { tasks: [task('a'), task('b', 1, ['a', 'a'])] }])
      expect(() => plan(input)).toThrow();
  });
});

test('CLI output and failures', async () => {
  const filename = `${import.meta.dir}/.test-input-${process.pid}.json`;
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, 'run', `${import.meta.dir}/cli.ts`, ...args]);
  try {
    await Bun.write(filename, JSON.stringify({ tasks: [task('build', 3)] }));
    const result = run('plan', filename);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe('');
    expect(result.stdout.toString().trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout.toString()).totalDuration).toBe(3);
    for (const args of [[], ['other', filename], ['plan', filename, '--flag'], ['plan', '--flag'], ['plan', `${filename}.missing`]]) {
      const failure = run(...args);
      expect(failure.exitCode).not.toBe(0);
      expect(failure.stdout.toString()).toBe('');
      expect(failure.stderr.toString().length).toBeGreaterThan(0);
    }
    await Bun.write(filename, '{');
    expect(run('plan', filename).stderr.toString()).toContain('Invalid JSON');
    await Bun.write(filename, JSON.stringify({ tasks: [task('a', 1, ['b']), task('b', 1, ['a'])] }));
    const cycle = run('plan', filename);
    expect(cycle.exitCode).not.toBe(0);
    expect(cycle.stderr.toString()).toContain('a -> b -> a');
  } finally {
    await Bun.file(filename).delete();
  }
});
