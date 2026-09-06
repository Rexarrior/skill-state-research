import { render } from "./engine";

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }

  const [templatePath, dataPath] = args;
  const [template, json] = await Promise.all([
    Bun.file(templatePath).text(),
    Bun.file(dataPath).text(),
  ]);
  const data: unknown = JSON.parse(json);
  await Bun.write(Bun.stdout, render(template, data));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await Bun.write(Bun.stderr, `mini-template: ${message}\n`);
  process.exitCode = 1;
}
