import { render } from "./engine";

declare const Bun: {
  file(path: string): { text(): Promise<string> };
};

declare const process: {
  readonly argv: string[];
  readonly stdout: { write(value: string): void };
  readonly stderr: { write(value: string): void };
  exitCode: number | undefined;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new Error("usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }

  const [templatePath, dataPath] = args as [string, string];
  const [template, json] = await Promise.all([
    Bun.file(templatePath).text(),
    Bun.file(dataPath).text(),
  ]);

  let data: unknown;
  try {
    data = JSON.parse(json) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON in ${dataPath}: ${detail}`);
  }

  process.stdout.write(render(template, data));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
