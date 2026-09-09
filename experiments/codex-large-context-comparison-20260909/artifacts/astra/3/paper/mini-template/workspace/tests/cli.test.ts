import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

 test('CLI writes exact UTF-8 output and reports failures only on stderr', async () => {
  const dir = await mkdtemp(join(import.meta.dir, '.cli-'));
  const template = join(dir, 'template.txt');
  const data = join(dir, 'data.json');
  async function run(args: string[]) {
    const proc = Bun.spawn([process.execPath, 'run', join(import.meta.dir, '../src/cli.ts'), ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }
  try {
    await writeFile(template, 'Привет {{name}}');
    await writeFile(data, JSON.stringify({ name: '<Ada>' }));
    expect(await run([template, data])).toEqual({ stdout: 'Привет &lt;Ada&gt;', stderr: '', code: 0 });
    for (const args of [[], [template], [template, data, 'extra'], [join(dir, 'missing'), data]]) {
      const result = await run(args);
      expect(result.code).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr.length).toBeGreaterThan(0);
    }
    await writeFile(data, '{invalid');
    expect((await run([template, data])).code).not.toBe(0);
    await writeFile(data, '{}');
    await writeFile(template, 'prefix{{/if}}');
    const result = await run([template, data]);
    expect(result.code).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain('line 1, column 7');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
