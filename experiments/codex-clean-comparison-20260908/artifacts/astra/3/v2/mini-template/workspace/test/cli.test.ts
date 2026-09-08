import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

let directory: string;
const cli = resolve(import.meta.dir, '../src/cli.ts');
beforeAll(async () => {
  directory = await mkdtemp(resolve(import.meta.dir, '.cli-'));
  await Promise.all([
    writeFile(join(directory, 'template.txt'), '雪 {{name}}\n'),
    writeFile(join(directory, 'data.json'), '{"name":"<Ada>"}'),
    writeFile(join(directory, 'invalid.json'), '{broken'),
    writeFile(join(directory, 'invalid.txt'), '{{#if name}}'),
  ]);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, 'run', cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}
test('CLI emits only the exact UTF-8 rendered text', async () => {
  expect(await run([join(directory, 'template.txt'), join(directory, 'data.json')])).toEqual({
    stdout: '雪 &lt;Ada&gt;\n', stderr: '', code: 0,
  });
});
test('CLI reports argument, file, JSON, and rendering errors on stderr', async () => {
  for (const args of [
    [], ['one'], ['one', 'two', 'three'],
    [join(directory, 'missing'), join(directory, 'data.json')],
    [join(directory, 'template.txt'), join(directory, 'invalid.json')],
    [join(directory, 'invalid.txt'), join(directory, 'data.json')],
  ]) {
    const result = await run(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
