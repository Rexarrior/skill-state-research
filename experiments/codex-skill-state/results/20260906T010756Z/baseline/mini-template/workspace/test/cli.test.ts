import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
let fixtureDirectory: string;

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "mini-template-test-"));
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

async function runCli(...arguments_: string[]) {
  const process = Bun.spawn([Bun.which("bun")!, "run", "src/cli.ts", ...arguments_], {
    cwd: projectDirectory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("CLI", () => {
  test("renders files and writes only the result to stdout", async () => {
    const templatePath = join(fixtureDirectory, "template.txt");
    const dataPath = join(fixtureDirectory, "data.json");
    await writeFile(templatePath, "Hi {{name}}!\n", "utf8");
    await writeFile(dataPath, JSON.stringify({ name: "A&B" }), "utf8");

    expect(await runCli(templatePath, dataPath)).toEqual({
      stdout: "Hi A&amp;B!\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("reports invalid input on stderr with a non-zero status", async () => {
    const templatePath = join(fixtureDirectory, "bad-template.txt");
    const dataPath = join(fixtureDirectory, "bad-data.json");
    await writeFile(templatePath, "{{name}}", "utf8");
    await writeFile(dataPath, "not JSON", "utf8");

    const result = await runCli(templatePath, dataPath);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("mini-template: ");
    expect(result.exitCode).not.toBe(0);
  });
});
