import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const cli = resolve(import.meta.dir, '../src/cli.ts');
let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(resolve(import.meta.dir, '.test-')); file = join(dir, 'tasks.json'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function run(args: string[], ok = true, custom = true) {
  const env = { ...process.env };
  delete env.TASKBOARD_FILE;
  if (custom) env.TASKBOARD_FILE = file;
  const p = Bun.spawnSync([process.execPath, 'run', cli, ...args], { cwd: dir, env });
  expect(p.exitCode === 0).toBe(ok);
  const output = p.stdout.toString().trim();
  expect(output.split('\n')).toHaveLength(1);
  expect(p.stderr.toString().length === 0).toBe(ok);
  const value = JSON.parse(output);
  if (!ok) expect(value).toBeNull();
  return value;
}
test('persistent CRUD, normalization, stable IDs, idempotence and atomic cleanup', () => {
  expect(run(['list'])).toEqual([]);
  const a = run(['add', '--title', '  First  ', '--tags', ' Work,work, URGENT,,', '--due', '2024-02-29']);
  expect(a).toMatchObject({ id: 1, title: 'First', status: 'open', tags: ['work', 'urgent'], due: '2024-02-29' });
  expect(new Date(a.createdAt).toISOString()).toBe(a.createdAt);
  expect(run(['list'])).toEqual([a]);
  const done = run(['done', '1']);
  expect(done.status).toBe('done');
  expect(new Date(done.completedAt).toISOString()).toBe(done.completedAt);
  const before = readFileSync(file, 'utf8');
  expect(run(['done', '1'])).toEqual(done);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(run(['delete', '1'])).toEqual(done);
  expect(run(['add', '--title', 'Second']).id).toBe(2);
  expect(readdirSync(dir)).toEqual(['tasks.json']);
});
test('combined filters, strict overdue boundary and local stats', () => {
  run(['add', '--title', 'Old', '--tags', 'A', '--due', '2000-01-01']);
  run(['add', '--title', 'Boundary', '--tags', 'b', '--due', '2000-01-02']);
  run(['add', '--title', 'Completed', '--tags', 'a', '--due', '2000-01-01']);
  run(['done', '3']);
  run(['add', '--title', 'Undated']);
  expect(run(['list', '--overdue', '2000-01-02']).map((t: any) => t.id)).toEqual([1]);
  expect(run(['list', '--status', 'open', '--tag', ' A ', '--overdue', '2000-01-03']).map((t: any) => t.id)).toEqual([1]);
  expect(run(['list', '--status', 'done', '--overdue', '2000-01-03'])).toEqual([]);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  run(['add', '--title', 'Today', '--due', today]);
  expect(run(['stats'])).toEqual({ total: 5, open: 4, done: 1, overdue: 2 });
});
test('invalid commands and inputs preserve data', () => {
  run(['add', '--title', 'Keep']);
  const before = readFileSync(file, 'utf8');
  const invalid = [[], ['unknown'], ['add'], ['add', '--title', ' '], ['add', '--title'], ['add', '--title', 'x', '--due', '2023-02-29'], ['add', '--title', 'x', '--due', '2024-04-31'], ['add', '--title', 'x', '--due', '2024-1-01'], ['list', '--status', 'bad'], ['list', '--overdue', 'bad'], ['list', '--tag', ' '], ['list', '--wat', 'x'], ['list', '--status', 'open', '--status', 'done'], ['done', '999'], ['delete', '999'], ['done', '1.0'], ['done', '0'], ['done', '1', 'extra'], ['stats', '--foo']];
  for (const args of invalid) { run(args, false); expect(readFileSync(file, 'utf8')).toBe(before); }
});
test('malformed JSON and invalid schemas are never replaced', () => {
  for (const raw of ['{', 'null', '{}', '{"version":1,"nextId":1,"tasks":[{"id":1}]}', '{"version":1,"nextId":0,"tasks":[]}']) {
    writeFileSync(file, raw);
    run(['add', '--title', 'No'], false);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  }
});
test('default storage and write failures', () => {
  run(['add', '--title', 'Default'], true, false);
  expect(JSON.parse(readFileSync(join(dir, '.taskboard.json'), 'utf8')).tasks).toHaveLength(1);
  file = join(dir, 'missing', 'tasks.json');
  run(['add', '--title', 'Fail'], false);
});
