import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const cli = resolve(import.meta.dir, '../src/cli.ts');
function fixture(run: (call: (args: string[], ok?: boolean, defaults?: boolean) => any, file: string, dir: string) => void) {
  const dir = mkdtempSync(resolve(import.meta.dir, '../.test-'));
  const file = join(dir, 'tasks.json');
  try {
    run((args, ok = true, defaults = false) => {
      const env = { ...process.env };
      if (defaults) delete env.TASKBOARD_FILE;
      else env.TASKBOARD_FILE = file;
      const result = Bun.spawnSync([process.execPath, 'run', cli, ...args], { cwd: dir, env });
      expect(result.exitCode === 0).toBe(ok);
      const output = result.stdout.toString().trim();
      expect(output.split('\n')).toHaveLength(1);
      const value = JSON.parse(output);
      if (ok) expect(result.stderr.toString()).toBe('');
      else { expect(value).toBeNull(); expect(result.stderr.toString().length).toBeGreaterThan(0); }
      return value;
    }, file, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('persistent lifecycle, filters, normalization, idempotence and stable IDs', () => fixture((call, file, dir) => {
  expect(call(['list'])).toEqual([]);
  const a = call(['add', '--title', '  First  ', '--tags', ' Work,work,HOME,, ', '--due', '2024-02-29']);
  expect(a).toMatchObject({ id: 1, title: 'First', tags: ['work', 'home'], status: 'open', due: '2024-02-29' });
  expect(new Date(a.createdAt).toISOString()).toBe(a.createdAt);
  call(['add', '--title', 'Second', '--due', '2024-03-01', '--tags', 'work']);
  call(['add', '--title', 'Third']);
  expect(call(['list', '--tag', ' WORK ', '--status', 'open', '--overdue', '2024-03-01']).map(t => t.id)).toEqual([1]);
  const done = call(['done', '1']);
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const before = readFileSync(file, 'utf8');
  expect(call(['done', '1'])).toEqual(done);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(call(['list', '--status', 'done', '--overdue', '2025-01-01'])).toEqual([]);
  expect(call(['delete', '3']).id).toBe(3);
  expect(call(['add', '--title', 'Fourth']).id).toBe(4);
  expect(call(['list']).map(t => t.id)).toEqual([1, 2, 4]);
  expect(readdirSync(dir)).toEqual(['tasks.json']);
}));
test('invalid inputs do not modify data', () => fixture((call, file) => {
  call(['add', '--title', 'Keep']);
  const before = readFileSync(file, 'utf8');
  for (const args of [[], ['wat'], ['add'], ['add', '--title', ' '], ['add', '--title', 'a', '--due', '2023-02-29'], ['add', '--title', 'a', '--due', '2024-04-31'], ['add', '--title', 'a', '--due', '2024-2-01'], ['add', '--title', 'a', '--unknown', 'b'], ['add', '--title', 'a', '--title', 'b'], ['list', '--status', 'bad'], ['list', '--tag'], ['list', '--overdue', 'no'], ['list', '--bad', 'x'], ['stats', 'x'], ['done', '999'], ['delete', '999'], ['done', '1.0'], ['delete', '1', '2']]) {
    call(args, false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  }
}));
test('malformed databases remain intact', () => fixture((call, file) => {
  const task = call(['add', '--title', 'Keep']);
  for (const text of ['{', 'null', '{}', JSON.stringify({ version: 1, nextId: 2, tasks: [task, task] }), JSON.stringify({ version: 1, nextId: 1, tasks: [task] }), JSON.stringify({ version: 1, nextId: 2, tasks: [{ ...task, due: '2025-02-30' }] })]) {
    writeFileSync(file, text);
    for (const args of [['list'], ['add', '--title', 'New'], ['done', '1'], ['delete', '1'], ['stats']]) {
      call(args, false);
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
  }
}));
test('stats uses local today and excludes done tasks and today', () => fixture((call) => {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  call(['add', '--title', 'Old', '--due', '2000-01-01']);
  call(['add', '--title', 'Today', '--due', today]);
  call(['add', '--title', 'Finished', '--due', '2000-01-01']);
  call(['done', '3']);
  call(['add', '--title', 'Undated']);
  expect(call(['stats'])).toEqual({ total: 4, open: 3, done: 1, overdue: 1 });
}));
test('default file persists across processes', () => fixture((call, file, dir) => {
  call(['add', '--title', 'Default'], true, true);
  expect(call(['list'], true, true)[0].title).toBe('Default');
  expect(readdirSync(dir)).toEqual(['.taskboard.json']);
}));
