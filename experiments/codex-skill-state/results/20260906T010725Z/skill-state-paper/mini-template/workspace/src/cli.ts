import { render } from "./engine";

async function main(): Promise<void> {
  const [templateFile, dataFile, extra] = Bun.argv.slice(2);
  if (!templateFile || !dataFile || extra) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }

  const [template, json] = await Promise.all([
    Bun.file(templateFile).text(),
    Bun.file(dataFile).text(),
  ]);
  const data: unknown = JSON.parse(json);
  await Bun.write(Bun.stdout, render(template, data));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`mini-template: ${message}`);
  process.exitCode = 1;
});
