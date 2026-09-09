import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const project = join(import.meta.dir, '..');
const dir = await mkdtemp(join(project, '.cli-test-'));
afterAll(() => rm(dir, { recursive: true, force: true }));
const template = join(dir, 'template.txt');
const data = join(dir, 'data.json');
await writeFile(template, 'Hello {{name}}!\n');
await writeFile(data, '{"name":"é<&"}');
async function cli(args: string[]) {
  const proc = Bun.spawn([process.execPath, 'run', 'src/cli.ts', ...args], { cwd: project, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}
test('CLI preserves UTF-8 and writes only rendered text', async () => {
  expect(await cli([template, data])).toEqual({ stdout: 'Hello é&lt;&amp;!\n', stderr: '', code: 0 });
});
test('CLI failures use stderr and nonzero status', async () => {
  const invalid = join(dir, 'invalid.json');
  const broken = join(dir, 'broken.txt');
  await writeFile(invalid, '{');
  await writeFile(broken, '{{else}}');
  for (const args of [[], [template], [template, data, 'extra'], [join(dir, 'missing'), data], [template, invalid], [broken, data]]) {
    const result = await cli(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
