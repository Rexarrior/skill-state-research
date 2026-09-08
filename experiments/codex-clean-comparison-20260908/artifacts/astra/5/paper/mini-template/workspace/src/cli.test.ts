import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const cli = join(import.meta.dir, 'cli.ts');
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, 'run', cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test('CLI renders exact UTF-8 and reports input and template errors', async () => {
  const dir = await mkdtemp(join(import.meta.dir, '.cli-test-'));
  const template = join(dir, 'template.txt');
  const data = join(dir, 'data.json');
  try {
    await writeFile(template, 'Привет {{name}}!');
    await writeFile(data, JSON.stringify({ name: '<世界>' }));
    expect(await run([template, data])).toEqual({ stdout: 'Привет &lt;世界&gt;!', stderr: '', code: 0 });
    for (const args of [[], [template], [template, data, 'extra'], [join(dir, 'missing'), data]]) {
      const result = await run(args);
      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    await writeFile(data, '{bad json');
    expect((await run([template, data])).code).not.toBe(0);
    await writeFile(data, '{}');
    await writeFile(template, 'prefix{{/if}}');
    const failure = await run([template, data]);
    expect(failure.code).not.toBe(0);
    expect(failure.stdout).toBe('');
    expect(failure.stderr).toContain('line 1, column 7');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
