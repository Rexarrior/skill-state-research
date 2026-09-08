import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const project = join(import.meta.dir, '..');
async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, 'run', 'src/cli.ts', ...args], { cwd: project, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
test('CLI output and errors', async () => {
  const dir = await mkdtemp(join(project, '.cli-test-'));
  try {
    const template = join(dir, 'template.txt');
    const data = join(dir, 'data.json');
    await writeFile(template, 'Hi {{name}}!\n');
    await writeFile(data, JSON.stringify({ name: '世界 & Ada' }));
    expect(await cli([template, data])).toEqual({ stdout: 'Hi 世界 &amp; Ada!\n', stderr: '', code: 0 });
    for (const args of [[], [template], [template, data, 'extra'], [join(dir, 'missing'), data]]) {
      const result = await cli(args);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    await writeFile(data, '{bad json');
    expect((await cli([template, data])).code).not.toBe(0);
    await writeFile(data, '{}');
    await writeFile(template, 'partial {{else}}');
    const result = await cli([template, data]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('line 1, column 9');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
