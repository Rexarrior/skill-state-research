import { afterEach, describe, expect, test } from "bun:test";

const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryFiles.splice(0).map((path) => Bun.file(path).delete()));
});

async function run(args: string[]) {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
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
  test("prints exactly one JSON object", async () => {
    const path = `${import.meta.dir}/input-${crypto.randomUUID()}.json`;
    temporaryFiles.push(path);
    await Bun.write(path, JSON.stringify({ tasks: [{ id: "build", duration: 3 }] }));
    const result = await run(["plan", path]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout).totalDuration).toBe(3);
  });

  test("rejects invalid JSON", async () => {
    const path = `${import.meta.dir}/input-${crypto.randomUUID()}.json`;
    temporaryFiles.push(path);
    await Bun.write(path, "{");
    const result = await run(["plan", path]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid JSON");
  });

  test("rejects cycles and unknown flags", async () => {
    const path = `${import.meta.dir}/input-${crypto.randomUUID()}.json`;
    temporaryFiles.push(path);
    await Bun.write(path, JSON.stringify({ tasks: [
      { id: "a", duration: 1, dependsOn: ["b"] },
      { id: "b", duration: 1, dependsOn: ["a"] },
    ] }));
    const cycle = await run(["plan", path]);
    expect(cycle.exitCode).not.toBe(0);
    expect(cycle.stderr).toContain("a -> b -> a");
    const flag = await run(["plan", path, "--verbose"]);
    expect(flag.exitCode).not.toBe(0);
    expect(flag.stderr).toContain("unknown argument or flag");
  });
});
