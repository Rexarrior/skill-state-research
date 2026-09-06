import { render } from "./engine";

const [templateFile, dataFile] = process.argv.slice(2);

if (!templateFile || !dataFile || process.argv.length !== 4) {
  console.error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  process.exit(1);
}

try {
  const template = await Bun.file(templateFile).text();
  const data = JSON.parse(await Bun.file(dataFile).text());
  process.stdout.write(render(template, data));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
