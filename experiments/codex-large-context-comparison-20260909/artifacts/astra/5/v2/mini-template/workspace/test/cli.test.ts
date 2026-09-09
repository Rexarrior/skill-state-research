import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const directory = mkdtempSync(join(import.meta.dir, '.cli-fixtures-'));
const template = join(directory, 'template.txt');
const data = join(directory, 'data.json');
const cli = resolve(import.meta.dir, '../src/cli.ts');
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function run(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, 'run', cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

test('CLI renders UTF-8 exactly without a trailing newline or diagnostics', () => {
  writeFileSync(template, 'Hello {{name}} — café');
  writeFileSync(data, JSON.stringify({ name: '<世界>' }));
  expect(run(template, data)).toEqual({ code: 0, out: 'Hello &lt;世界&gt; — café', err: '' });
});

test('CLI reports bad arguments, missing files, invalid JSON and template errors only to stderr', () => {
  writeFileSync(template, '{{name}}');
  writeFileSync(data, '{}');
  for (const args of [[], [template], [template, data, 'extra'], [join(directory, 'missing'), data]]) {
    const result = run(...args);
    expect(result.code).not.toBe(0);
    expect(result.out).toBe('');
    expect(result.err.length).toBeGreaterThan(0);
  }
  writeFileSync(data, '{invalid');
  expect(run(template, data).code).not.toBe(0);
  expect(run(template, data).out).toBe('');
  expect(run(template, data).err.length).toBeGreaterThan(0);
  writeFileSync(data, '{}');
  writeFileSync(template, 'prefix\n{{else}}');
  const result = run(template, data);
  expect(result.code).not.toBe(0);
  expect(result.out).toBe('');
  expect(result.err).toContain('line 2, column 1');
});
