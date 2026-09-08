import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
const cli = resolve(import.meta.dir, '../src/cli.ts');
function fixture(run: (call: (args: string[], ok?: boolean) => any, file: string) => void) {
  const dir = mkdtempSync(resolve(import.meta.dir, '.taskboard-test-'));
  const file = join(dir, 'db.json');
  const call = (args: string[], ok = true) => {
    const p = Bun.spawnSync([process.execPath, 'run', cli, ...args], { cwd: dir, env: { ...process.env, TASKBOARD_FILE: file } });
    expect(p.exitCode === 0).toBe(ok);
    const out = p.stdout.toString().trim();
    expect(out.split('\n')).toHaveLength(1);
    const value = JSON.parse(out);
    if (ok) expect(p.stderr.toString()).toBe('');
    else { expect(p.stderr.toString().length).toBeGreaterThan(0); expect(value.error).toBeString(); }
    return value;
  };
  try { run(call, file); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('persistent lifecycle, filters, monotonic IDs and idempotence', () => fixture((call, file) => {
  expect(call(['list'])).toEqual([]);
  const a = call(['add', '--title', ' First ', '--tags', ' Work,work, URGENT,,', '--due', '2000-02-29']);
  expect(a).toMatchObject({ id: 1, title: 'First', tags: ['work', 'urgent'], status: 'open' });
  expect(new Date(a.createdAt).toISOString()).toBe(a.createdAt);
  call(['add', '--title', 'Second', '--due', '2000-03-01']);
  expect(call(['list', '--tag', 'WORK', '--status', 'open', '--overdue', '2000-03-01'])).toEqual([a]);
  expect(call(['list', '--overdue', '2000-02-29'])).toEqual([]);
  const done = call(['done', '1']);
  const before = readFileSync(file, 'utf8');
  expect(call(['done', '1'])).toEqual(done);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(call(['stats'])).toEqual({ total: 2, open: 1, done: 1, overdue: 1 });
  expect(call(['list', '--status', 'done', '--overdue', '2099-01-01'])).toEqual([]);
  expect(call(['delete', '2']).id).toBe(2);
  expect(call(['add', '--title', 'Third']).id).toBe(3);
  expect(call(['list']).map((t: any) => t.id)).toEqual([1, 3]);
  expect(readdirSync(resolve(file, '..'))).toEqual(['db.json']);
}));
test('invalid input leaves stored bytes unchanged', () => fixture((call, file) => {
  call(['add', '--title', 'Keep']);
  const before = readFileSync(file, 'utf8');
  for (const args of [[], ['wat'], ['list', '--wat'], ['stats', 'extra'], ['add'], ['add', '--title', ' '], ['add', '--title'], ['add', '--title', 'x', '--due', '2025-02-29'], ['add', '--title', 'x', '--due', '2024-04-31'], ['list', '--overdue', '2024-2-01'], ['list', '--status', 'unknown'], ['list', '--status', 'open', '--status', 'done'], ['done', '999'], ['delete', '999'], ['done', '1.0'], ['delete', '1', '2']]) {
    call(args, false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  }
}));
test('malformed databases never get replaced', () => fixture((call, file) => {
  for (const raw of ['{oops', '{}', 'null', '{"version":1,"nextId":1,"tasks":[{}]}']) {
    writeFileSync(file, raw);
    call(['add', '--title', 'No'], false);
    expect(readFileSync(file, 'utf8')).toBe(raw);
  }
}));
test('default storage survives processes', () => {
  const dir = mkdtempSync(resolve(import.meta.dir, '.taskboard-test-'));
  const env = { ...process.env }; delete env.TASKBOARD_FILE;
  try {
    const run = (args: string[]) => Bun.spawnSync([process.execPath, 'run', cli, ...args], { cwd: dir, env });
    expect(run(['add', '--title', 'Default']).exitCode).toBe(0);
    expect(JSON.parse(run(['list']).stdout.toString())[0].title).toBe('Default');
    expect(readdirSync(dir)).toEqual(['.taskboard.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
