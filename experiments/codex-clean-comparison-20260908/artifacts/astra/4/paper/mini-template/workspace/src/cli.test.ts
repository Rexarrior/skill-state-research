import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const cli = new URL('./cli.ts', import.meta.url).pathname;
test('CLI renders exact UTF-8 stdout and reports failures only on stderr', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.cli-test-'));
  async function run(args: string[]) {
    const child = Bun.spawn([process.execPath, 'run', cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  }
  try {
    const template = join(dir, 'template');
    const data = join(dir, 'data.json');
    await writeFile(template, 'Привет {{name}}!');
    await writeFile(data, '{"name":"<世界>"}');
    expect(await run([template, data])).toEqual({ stdout: 'Привет &lt;世界&gt;!', stderr: '', code: 0 });
    for (const args of [[], [template], [template, data, 'extra'], [join(dir, 'absent'), data]]) {
      const result = await run(args);
      expect(result.code).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr.length).toBeGreaterThan(0);
    }
    await writeFile(data, 'invalid json');
    expect((await run([template, data])).code).not.toBe(0);
    await writeFile(data, '{}');
    await writeFile(template, '{{/each}}');
    const result = await run([template, data]);
    expect(result.code).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).toContain('line 1, column 1');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
