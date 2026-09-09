import { render } from "./engine.ts";

try {
  const args = Bun.argv.slice(2);
  if (args.length !== 2) {
    throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  }
  const [template, json] = await Promise.all([
    Bun.file(args[0]!).text(),
    Bun.file(args[1]!).text(),
  ]);
  const result = render(template, JSON.parse(json));
  await Bun.write(Bun.stdout, result);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
