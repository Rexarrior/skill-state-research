import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

test("CLI renders files to stdout without extra output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mini-template-"));
  try {
    const template = join(directory, "template.txt");
    const data = join(directory, "data.json");
    await writeFile(template, "Hello, {{name}}!");
    await writeFile(data, JSON.stringify({ name: "<Ada>" }));

    const child = Bun.spawn([process.execPath, "run", "src/cli.ts", template, data], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe("Hello, &lt;Ada&gt;!");
    expect(stderr).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI reports errors on stderr and exits non-zero", async () => {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).not.toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toContain("Usage:");
});
