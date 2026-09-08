import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = await mkdtemp(join(import.meta.dir, '.cli-'));
const template = join(directory, 'template.txt');
const data = join(directory, 'data.json');
afterAll(() => rm(directory, { recursive: true, force: true }));
async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, 'run', join(import.meta.dir, '../src/cli.ts'), ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
test('CLI UTF-8 output is exact', async () => {
  await writeFile(template, 'Héllo {{name}}!');
  await writeFile(data, JSON.stringify({ name: '世界 & friends' }));
  expect(await cli([template, data])).toEqual({ stdout: 'Héllo 世界 &amp; friends!', stderr: '', code: 0 });
});
test('CLI errors use stderr and fail without partial stdout', async () => {
  await writeFile(data, '{}');
  await writeFile(template, 'prefix{{else}}');
  for (const args of [[], [template], [template, data, 'extra'], [join(directory, 'missing'), data], [template, data]]) {
    const result = await cli(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
  }
  await writeFile(data, '{broken');
  const result = await cli([template, data]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr.length).toBeGreaterThan(0);
});
