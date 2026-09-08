import { dirname, basename, resolve } from "node:path";
import { rename, unlink, writeFile } from "node:fs/promises";

type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  status: Status;
  createdAt: string;
  tags: string[];
  due?: string;
  completedAt?: string;
}

interface Database {
  version: 1;
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const emptyDatabase = (): Database => ({ version: 1, nextId: 1, tasks: [] });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12 || day < 1) return false;

  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of value.split(",")) {
    const tag = normalizeTag(part);
    if (tag !== "" && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) return false;
  if (value.tags.some((tag) => tag === "" || tag !== normalizeTag(tag))) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && !isIsoTimestamp(value.completedAt)) return false;
  return true;
}

function validateDatabase(value: unknown): value is Database {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !["version", "nextId", "tasks"].includes(key))) return false;
  if (value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) return false;
  if (!Array.isArray(value.tasks) || !value.tasks.every(validateTask)) return false;

  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) return false;
  return ids.every((id) => id < (value.nextId as number));
}

async function loadDatabase(path: string): Promise<Database> {
  let source: string;
  try {
    source = await Bun.file(path).text();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return emptyDatabase();
    throw new CliError(`cannot read database: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new CliError("database contains invalid JSON");
  }
  if (!validateDatabase(value)) throw new CliError("database has an invalid structure");
  return value;
}

async function saveDatabase(path: string, database: Database): Promise<void> {
  const directory = dirname(path);
  const temporary = resolve(directory, `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // The temporary file might not have been created, or rename already consumed it.
    }
    throw new CliError(`cannot write database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface ParsedArguments {
  positionals: string[];
  flags: Map<string, string>;
}

function parseArguments(args: string[], allowedFlags: ReadonlySet<string>): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (!allowedFlags.has(argument)) throw new CliError(`unknown flag: ${argument}`);
    if (flags.has(argument)) throw new CliError(`duplicate flag: ${argument}`);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new CliError(`missing value for ${argument}`);
    flags.set(argument, value);
  }
  return { positionals, flags };
}

function requireNoPositionals(positionals: string[]): void {
  if (positionals.length > 0) throw new CliError(`unexpected argument: ${positionals[0]}`);
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new CliError("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new CliError("ID must be a positive integer");
  return id;
}

function localDate(now = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function execute(args: string[], databasePath: string): Promise<unknown> {
  const command = args[0];
  const rest = args.slice(1);
  if (command === undefined) throw new CliError("missing command");

  if (command === "add") {
    const parsed = parseArguments(rest, new Set(["--title", "--tags", "--due"]));
    requireNoPositionals(parsed.positionals);
    const title = parsed.flags.get("--title");
    if (title === undefined) throw new CliError("missing required flag: --title");
    if (title.trim() === "") throw new CliError("title must not be empty");
    const due = parsed.flags.get("--due");
    if (due !== undefined && !isDate(due)) throw new CliError("due date must be a valid YYYY-MM-DD date");

    const database = await loadDatabase(databasePath);
    if (database.nextId === Number.MAX_SAFE_INTEGER) throw new CliError("task ID space is exhausted");
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: normalizeTags(parsed.flags.get("--tags") ?? ""),
      ...(due === undefined ? {} : { due }),
    };
    database.nextId++;
    database.tasks.push(task);
    await saveDatabase(databasePath, database);
    return task;
  }

  if (command === "list") {
    const parsed = parseArguments(rest, new Set(["--status", "--tag", "--overdue"]));
    requireNoPositionals(parsed.positionals);
    const status = parsed.flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      throw new CliError("status must be open or done");
    }
    const overdue = parsed.flags.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) {
      throw new CliError("overdue date must be a valid YYYY-MM-DD date");
    }
    const tagValue = parsed.flags.get("--tag");
    const tag = tagValue === undefined ? undefined : normalizeTag(tagValue);
    if (tag !== undefined && tag === "") throw new CliError("tag must not be empty");

    const database = await loadDatabase(databasePath);
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done" || command === "delete") {
    const parsed = parseArguments(rest, new Set());
    if (parsed.positionals.length !== 1) throw new CliError(`${command} requires exactly one ID`);
    const id = parseId(parsed.positionals[0]);
    const database = await loadDatabase(databasePath);
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) throw new CliError(`task ${id} does not exist`);

    if (command === "delete") {
      const [deleted] = database.tasks.splice(index, 1);
      await saveDatabase(databasePath, database);
      return deleted;
    }

    const task = database.tasks[index]!;
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(databasePath, database);
    }
    return task;
  }

  if (command === "stats") {
    const parsed = parseArguments(rest, new Set());
    requireNoPositionals(parsed.positionals);
    const database = await loadDatabase(databasePath);
    const today = localDate();
    const open = database.tasks.filter((task) => task.status === "open");
    return {
      total: database.tasks.length,
      open: open.length,
      done: database.tasks.length - open.length,
      overdue: open.filter((task) => task.due !== undefined && task.due < today).length,
    };
  }

  throw new CliError(`unknown command: ${command}`);
}

async function main(): Promise<void> {
  const databasePath = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  try {
    const result = await execute(process.argv.slice(2), databasePath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write("null\n");
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

await main();
