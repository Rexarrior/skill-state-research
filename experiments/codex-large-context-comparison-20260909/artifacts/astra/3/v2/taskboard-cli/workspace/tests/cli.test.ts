import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const entry = resolve(import.meta.dir, '../src/cli.ts');
let directory: string;
let file: string;
beforeEach(() => { directory = mkdtempSync(join(import.meta.dir, '.run-')); file = join(directory, 'board.json'); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function run(args: string[], success = true, defaultFile = false) {
  const env = { ...process.env, TASKBOARD_FILE: file };
  if (defaultFile) delete env.TASKBOARD_FILE;
  const result = Bun.spawnSync([process.execPath, 'run', entry, ...args], { cwd: directory, env });
  const stdout = result.stdout.toString();
  expect(stdout.trim().split('\n')).toHaveLength(1);
  const value = JSON.parse(stdout);
  expect(result.exitCode === 0).toBe(success);
  if (success) expect(result.stderr.toString()).toBe('');
  else { expect(result.stderr.toString().length).toBeGreaterThan(0); expect(value.error).toBeString(); }
  return value;
}
test('persists tasks across processes, normalizes tags, combines filters, completes idempotently, never reuses IDs', () => {
  expect(run(['list'])).toEqual([]);
  const first = run(['add', '--title', ' First ', '--tags', ' Work,work, HOME,, ', '--due', '2024-02-29']);
  expect(first).toMatchObject({ id: 1, title: 'First', status: 'open', tags: ['work', 'home'], due: '2024-02-29' });
  expect(new Date(first.createdAt).toISOString()).toBe(first.createdAt);
  run(['add', '--title', 'Second', '--tags', 'work', '--due', '2024-03-01']);
  run(['add', '--title', 'Third']);
  expect(run(['list']).map((task: any) => task.id)).toEqual([1, 2, 3]);
  expect(run(['list', '--status', 'open', '--tag', ' WORK ', '--overdue', '2024-03-01']).map((task: any) => task.id)).toEqual([1]);
  expect(run(['list', '--overdue', '2024-02-29'])).toEqual([]);
  const done = run(['done', '1']);
  expect(done.status).toBe('done');
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const bytes = readFileSync(file, 'utf8');
  expect(run(['done', '1'])).toEqual(done);
  expect(readFileSync(file, 'utf8')).toBe(bytes);
  expect(run(['list', '--status', 'done'])).toEqual([done]);
  expect(run(['list', '--status', 'done', '--overdue', '2030-01-01'])).toEqual([]);
  expect(run(['delete', '3']).id).toBe(3);
  expect(run(['add', '--title', 'Fourth']).id).toBe(4);
  expect(readdirSync(directory)).toEqual(['board.json']);
});
test('invalid arguments and missing tasks never change the database', () => {
  run(['add', '--title', 'Keep']);
  const bytes = readFileSync(file, 'utf8');
  for (const args of [[], ['wat'], ['stats', '--wat'], ['add'], ['add', '--title', ' '],
    ['add', '--title'], ['add', '--title', 'x', '--due', '2023-02-29'],
    ['add', '--title', 'x', '--due', '2024-04-31'], ['list', '--overdue', '2024-1-01'],
    ['list', '--status', 'pending'], ['list', '--tag', ' '], ['list', '--wat', 'x'],
    ['add', '--title', 'x', '--title', 'y'], ['done'], ['done', '1.0'], ['done', '-1'],
    ['done', '9007199254740992'], ['delete', '1', '2'], ['done', '99'], ['delete', '99']]) {
    run(args, false);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  }
});
test('rejects malformed JSON and malformed schema without replacing data', () => {
  const task = run(['add', '--title', 'Keep']);
  const bad = ['{', 'null', '{}', JSON.stringify({ version: 1, nextId: 1, tasks: [task] }),
    JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] }),
    ...[{ tags: ['X'] }, { due: '2025-02-29' }, { status: 'done' }, { createdAt: 'bad' }].map(change =>
      JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, ...change }] }))];
  for (const bytes of bad) {
    writeFileSync(file, bytes);
    for (const args of [['list'], ['stats'], ['add', '--title', 'No'], ['done', '1'], ['delete', '1']]) {
      run(args, false);
      expect(readFileSync(file, 'utf8')).toBe(bytes);
    }
  }
});
test('stats uses strict local-date boundaries and excludes done tasks', () => {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  run(['add', '--title', 'Past', '--due', '2000-01-01']);
  run(['add', '--title', 'Today', '--due', today]);
  run(['add', '--title', 'Completed past', '--due', '2000-01-01']);
  run(['done', '3']);
  run(['add', '--title', 'No date']);
  expect(run(['stats'])).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
});
test('default file and empty board stats', () => {
  expect(run(['stats'], true, true)).toEqual({ total: 0, open: 0, done: 0, overdue: 0 });
  run(['add', '--title', 'Default'], true, true);
  expect(run(['list'], true, true)).toHaveLength(1);
  expect(readdirSync(directory)).toEqual(['.taskboard.json']);
});
