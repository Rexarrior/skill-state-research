import { render } from "./engine";

async function main(): Promise<void> {
  const [templatePath, dataPath, ...extra] = Bun.argv.slice(2);
  if (!templatePath || !dataPath || extra.length > 0) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }

  const templateFile = Bun.file(templatePath);
  const dataFile = Bun.file(dataPath);
  if (!(await templateFile.exists())) throw new Error(`Template file not found: ${templatePath}`);
  if (!(await dataFile.exists())) throw new Error(`Data file not found: ${dataPath}`);

  const template = await templateFile.text();
  let data: unknown;
  try {
    data = JSON.parse(await dataFile.text());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${dataPath}: ${detail}`);
  }

  await Bun.write(Bun.stdout, render(template, data));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
