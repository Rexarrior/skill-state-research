import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const cli = join(import.meta.dir, '../src/cli.ts');
test('CLI writes exact output and reports usage, file, JSON, and render errors', async () => {
  const directory = await mkdtemp(join(import.meta.dir, '.cli-'));
  const template = join(directory, 'template.txt');
  const data = join(directory, 'data.json');
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, 'run', cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  try {
    await Bun.write(template, 'héllo {{name}}!');
    await Bun.write(data, '{"name":"<world>"}');
    expect(await run([template, data])).toEqual({ stdout: 'héllo &lt;world&gt;!', stderr: '', code: 0 });
    for (const args of [[], [template], [template, data, 'extra'], [join(directory, 'missing'), data]]) {
      const result = await run(args);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    await Bun.write(data, 'invalid JSON');
    expect((await run([template, data])).code).not.toBe(0);
    await Bun.write(data, '{}');
    await Bun.write(template, '{{#if x}}');
    const result = await run([template, data]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('line 1, column 1');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
