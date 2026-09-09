import { expect, test } from "bun:test";

test("CLI renders files and writes only the result to stdout", async () => {
  const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/mini-template-`),
  );
  await Bun.write(`${directory}/template.txt`, "Hello, {{name}}!");
  await Bun.write(`${directory}/data.json`, JSON.stringify({ name: "<Bun>" }));
  const processResult = Bun.spawn([
    process.execPath,
    "run",
    "src/cli.ts",
    `${directory}/template.txt`,
    `${directory}/data.json`,
  ], { stdout: "pipe", stderr: "pipe" });

  expect(await processResult.exited).toBe(0);
  expect(await new Response(processResult.stdout).text()).toBe("Hello, &lt;Bun&gt;!");
  expect(await new Response(processResult.stderr).text()).toBe("");
});

test("CLI errors use stderr and a non-zero status", async () => {
  const processResult = Bun.spawn([process.execPath, "run", "src/cli.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await processResult.exited).not.toBe(0);
  expect(await new Response(processResult.stdout).text()).toBe("");
  expect(await new Response(processResult.stderr).text()).toContain("Usage:");
});
