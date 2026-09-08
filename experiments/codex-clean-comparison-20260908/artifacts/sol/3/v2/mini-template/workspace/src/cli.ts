import { render } from "./engine";

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length !== 2) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }

  const [templateFile, dataFile] = args;
  const template = await Bun.file(templateFile).text();
  const dataText = await Bun.file(dataFile).text();
  let data: unknown;
  try {
    data = JSON.parse(dataText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${dataFile}: ${detail}`);
  }
  await Bun.write(Bun.stdout, render(template, data));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
