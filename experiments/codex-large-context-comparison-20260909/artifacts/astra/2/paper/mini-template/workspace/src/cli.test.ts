import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

test('CLI emits exact output and reports failures only on stderr', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.cli-test-'));
  const template = join(dir, 'template.txt');
  const data = join(dir, 'data.json');
  const run = (args: string[]) => Bun.spawnSync([process.execPath, 'run', 'src/cli.ts', ...args], { cwd: process.cwd() });
  try {
    await Bun.write(template, 'héllo {{name}}\n');
    await Bun.write(data, '{"name":"<&>"}');
    const success = run([template, data]);
    expect(success.exitCode).toBe(0);
    expect(success.stdout.toString()).toBe('héllo &lt;&amp;&gt;\n');
    expect(success.stderr.toString()).toBe('');
    for (const args of [[], [template], [template, data, 'extra'], [join(dir, 'missing'), data]]) {
      const result = run(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
    }
    await Bun.write(data, '{invalid');
    expect(run([template, data]).exitCode).not.toBe(0);
    await Bun.write(data, '{}');
    await Bun.write(template, '{{/if}}');
    const invalid = run([template, data]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stdout.toString()).toBe('');
    expect(invalid.stderr.toString()).toContain('line 1, column 1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
