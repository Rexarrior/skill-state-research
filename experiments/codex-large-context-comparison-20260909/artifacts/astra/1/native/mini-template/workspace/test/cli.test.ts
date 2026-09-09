import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const directory = `${project}.test-fixtures-${process.pid}`;

beforeAll(async () => {
  await mkdir(directory);
  await Promise.all([
    Bun.write(`${directory}/template.txt`, "héllo {{name}}\n{{#each items}}{{this}}{{/each}}"),
    Bun.write(`${directory}/data.json`, JSON.stringify({ name: "<world>", items: [1, 2] })),
    Bun.write(`${directory}/invalid.json`, "{"),
    Bun.write(`${directory}/invalid.txt`, "prefix{{#if x}}"),
    Bun.write(`${directory}/object.txt`, "prefix{{this}}"),
  ]);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: project, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI writes exact UTF-8 output without an extra newline", async () => {
  expect(await cli([`${directory}/template.txt`, `${directory}/data.json`]))
    .toEqual({ stdout: "héllo &lt;world&gt;\n12", stderr: "", code: 0 });
});

test("CLI errors exit nonzero, report to stderr, and emit no partial output", async () => {
  const cases = [
    [],
    ["one"],
    ["one", "two", "three"],
    [`${directory}/missing.txt`, `${directory}/data.json`],
    [`${directory}/template.txt`, `${directory}/missing.json`],
    [`${directory}/template.txt`, `${directory}/invalid.json`],
    [`${directory}/invalid.txt`, `${directory}/data.json`],
    [`${directory}/object.txt`, `${directory}/data.json`],
  ];
  for (const args of cases) {
    const result = await cli(args);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.length).toBeGreaterThan(0);
  }
});
