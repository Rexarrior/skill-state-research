import { render } from "./engine";

const [templateFile, dataFile] = Bun.argv.slice(2);

if (!templateFile || !dataFile || Bun.argv.slice(2).length !== 2) {
  console.error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  process.exitCode = 1;
} else {
  try {
    const [template, rawData] = await Promise.all([
      Bun.file(templateFile).text(),
      Bun.file(dataFile).text(),
    ]);
    process.stdout.write(render(template, JSON.parse(rawData)));
  } catch (reason) {
    console.error(reason instanceof Error ? reason.message : String(reason));
    process.exitCode = 1;
  }
}
