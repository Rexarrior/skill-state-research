import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const project = new URL('..', import.meta.url).pathname;
async function cli(args: string[]) {
  const proc = Bun.spawn([process.execPath, 'run', 'src/cli.ts', ...args], { cwd: project, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

test('CLI handles UTF-8, exact output and errors', async () => {
  const dir = await mkdtemp(join(project, '.cli-test-'));
  const template = join(dir, 'template.txt');
  const data = join(dir, 'data.json');
  try {
    await writeFile(template, 'Hi {{name}}!\n終');
    await writeFile(data, JSON.stringify({ name: 'É<&' }));
    expect(await cli([template, data])).toEqual({ stdout: 'Hi É&lt;&amp;!\n終', stderr: '', code: 0 });
    for (const args of [[], [template], [template, data, 'extra'], [join(dir, 'missing'), data]]) {
      const result = await cli(args);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    await writeFile(data, '{broken');
    const invalidJson = await cli([template, data]);
    expect(invalidJson.code).not.toBe(0);
    expect(invalidJson.stdout).toBe('');
    expect(invalidJson.stderr.length).toBeGreaterThan(0);
    await writeFile(data, '{}');
    await writeFile(template, 'prefix\n{{/if}}');
    const invalidTemplate = await cli([template, data]);
    expect(invalidTemplate.code).not.toBe(0);
    expect(invalidTemplate.stdout).toBe('');
    expect(invalidTemplate.stderr).toContain('line 2, column 1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
