import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

let directory: string;
const cli = resolve(import.meta.dir, '../src/cli.ts');
beforeAll(async () => {
  directory = await mkdtemp(join(import.meta.dir, '.cli-'));
  await writeFile(join(directory, 'template.txt'), 'héllo {{name}}');
  await writeFile(join(directory, 'data.json'), '{"name":"<世界>"}');
  await writeFile(join(directory, 'invalid.json'), '{');
  await writeFile(join(directory, 'broken.txt'), '{{#if name}}');
  await writeFile(join(directory, 'object.json'), '{"name":{}}');
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function run(...args: string[]) {
  const process = Bun.spawn([Bun.which('bun')!, 'run', cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  return { stdout, stderr, code };
}
test('CLI outputs exact UTF-8 rendered text', async () => {
  expect(await run(join(directory, 'template.txt'), join(directory, 'data.json')))
    .toEqual({ stdout: 'héllo &lt;世界&gt;', stderr: '', code: 0 });
});
test('CLI handles usage, missing files, invalid JSON, syntax and scalar errors', async () => {
  const cases = [[], ['one'], ['one', 'two', 'three'],
    [join(directory, 'missing'), join(directory, 'data.json')],
    [join(directory, 'template.txt'), join(directory, 'invalid.json')],
    [join(directory, 'broken.txt'), join(directory, 'data.json')],
    [join(directory, 'template.txt'), join(directory, 'object.json')],
  ];
  for (const args of cases) {
    const result = await run(...args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
