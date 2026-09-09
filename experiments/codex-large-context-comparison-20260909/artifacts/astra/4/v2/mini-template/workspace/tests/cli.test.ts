import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

let directory: string;
const cli = new URL('../src/cli.ts', import.meta.url).pathname;
beforeAll(async () => {
  directory = await mkdtemp(join(process.cwd(), '.cli-test-'));
  await Promise.all([
    writeFile(join(directory, 'template'), 'Héllo {{name}}!\n'),
    writeFile(join(directory, 'data.json'), JSON.stringify({ name: '<世界>' })),
    writeFile(join(directory, 'bad.json'), '{'),
    writeFile(join(directory, 'bad-template'), '{{else}}'),
  ]);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, 'run', cli, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test('CLI writes exact UTF-8 output', async () => {
  expect(await run([join(directory, 'template'), join(directory, 'data.json')])).toEqual({
    stdout: 'Héllo &lt;世界&gt;!\n', stderr: '', exitCode: 0,
  });
});
test('CLI failures go to stderr with no partial stdout', async () => {
  for (const args of [
    [], ['a', 'b', 'c'],
    [join(directory, 'missing'), join(directory, 'data.json')],
    [join(directory, 'template'), join(directory, 'missing.json')],
    [join(directory, 'template'), join(directory, 'bad.json')],
    [join(directory, 'bad-template'), join(directory, 'data.json')],
  ]) {
    const result = await run(args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stdout).toBe('');
  }
});
