import { render } from "./engine";

try {
  const args = Bun.argv.slice(2);
  if (args.length !== 2) throw new Error("Usage: bun run src/cli.ts TEMPLATE_FILE DATA.json");
  const template = await Bun.file(args[0]).text();
  const data: unknown = JSON.parse(await Bun.file(args[1]).text());
  const output = render(template, data);
  await Bun.write(Bun.stdout, output);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
