import { TaskStore, UsageError, isDate, localDate, normalizeTag, type TaskStatus } from "./taskboard";

type Options = Record<string, string>;

function parseOptions(args: string[], allowed: Set<string>): Options {
  const options: Options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !allowed.has(flag) || value === undefined || value.startsWith("--")) {
      throw new UsageError(`Unknown or incomplete argument: ${flag ?? "<missing>"}`);
    }
    if (options[flag] !== undefined) throw new UsageError(`Duplicate flag: ${flag}`);
    options[flag] = value;
  }
  return options;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new UsageError("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new UsageError("ID must be a positive integer");
  return id;
}

async function execute(args: string[], file: string): Promise<unknown> {
  const [command, ...rest] = args;
  const store = new TaskStore(file);

  switch (command) {
    case "add": {
      const options = parseOptions(rest, new Set(["--title", "--tags", "--due"]));
      if (options["--title"] === undefined) throw new UsageError("add requires --title TEXT");
      const title = options["--title"].trim();
      if (title === "") throw new UsageError("Title must not be empty");
      const due = options["--due"];
      if (due !== undefined && !isDate(due)) throw new UsageError("Due date must be a valid YYYY-MM-DD date");
      const tags = options["--tags"] === undefined
        ? []
        : [...new Set(options["--tags"].split(",").map(normalizeTag).filter(Boolean))];
      return store.add(title, tags, due);
    }
    case "list": {
      const options = parseOptions(rest, new Set(["--status", "--tag", "--overdue"]));
      const status = options["--status"];
      if (status !== undefined && status !== "open" && status !== "done") {
        throw new UsageError("Status must be open or done");
      }
      const overdue = options["--overdue"];
      if (overdue !== undefined && !isDate(overdue)) {
        throw new UsageError("Overdue date must be a valid YYYY-MM-DD date");
      }
      const rawTag = options["--tag"];
      const tag = rawTag === undefined ? undefined : normalizeTag(rawTag);
      if (rawTag !== undefined && tag === "") throw new UsageError("Tag must not be empty");
      return store.list({ status: status as TaskStatus | undefined, tag, overdue });
    }
    case "done":
      if (rest.length !== 1) throw new UsageError("done requires exactly one ID");
      return store.done(parseId(rest[0]));
    case "delete":
      if (rest.length !== 1) throw new UsageError("delete requires exactly one ID");
      return store.delete(parseId(rest[0]));
    case "stats":
      if (rest.length !== 0) throw new UsageError("stats does not accept arguments");
      return store.stats(localDate());
    default:
      throw new UsageError(command === undefined ? "Missing command" : `Unknown command: ${command}`);
  }
}

export async function main(args = Bun.argv.slice(2)): Promise<number> {
  try {
    const result = await execute(args, process.env.TASKBOARD_FILE ?? ".taskboard.json");
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.log(JSON.stringify({ error: message }));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
