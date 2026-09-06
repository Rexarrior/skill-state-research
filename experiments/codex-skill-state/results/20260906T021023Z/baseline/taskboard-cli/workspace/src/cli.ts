import { rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const databasePath = process.env.TASKBOARD_FILE || join(process.cwd(), ".taskboard.json");

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;

  const daysInMonth = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function requireDate(value: string, option: string): string {
  if (!isDate(value)) throw new CliError(`${option} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTask(value: unknown): value is Task {
  if (!isPlainObject(value)) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "" || value.title !== value.title.trim()) return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags)) return false;

  const tags = value.tags;
  if (!tags.every((tag) => typeof tag === "string" && tag !== "" && tag === normalizeTag(tag))) return false;
  if (new Set(tags).size !== tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;

  if (value.status === "done") {
    if (!isIsoTimestamp(value.completedAt)) return false;
  } else if (value.completedAt !== undefined) {
    return false;
  }

  return true;
}

function validateDatabase(value: unknown): asserts value is Database {
  if (!isPlainObject(value) || !Array.isArray(value.tasks) || !Number.isSafeInteger(value.nextId)) {
    throw new CliError("database has an invalid structure");
  }
  if ((value.nextId as number) < 1 || !value.tasks.every(validateTask)) {
    throw new CliError("database contains invalid data");
  }

  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) throw new CliError("database contains duplicate task ids");
  if (ids.some((id) => id >= (value.nextId as number))) {
    throw new CliError("database nextId is inconsistent with its tasks");
  }
}

async function readDatabase(): Promise<Database> {
  let contents: string;
  try {
    contents = await Bun.file(databasePath).text();
  } catch (error) {
    if (isPlainObject(error) && error.code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new CliError("database is not valid JSON");
  }
  validateDatabase(parsed);
  return parsed;
}

async function writeDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = join(
    directory,
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Nothing to clean up if creating or renaming the temporary file failed.
    }
    throw error;
  }
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag.startsWith("--") || !allowed.has(flag)) throw new CliError(`unknown flag or argument: ${flag}`);
    if (flags.has(flag)) throw new CliError(`flag specified more than once: ${flag}`);

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError(`missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new CliError("task ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new CliError("task ID is too large");
  return id;
}

function findTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new CliError(`task ${id} does not exist`);
  return task;
}

function localDate(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function execute(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) throw new CliError("missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title")?.trim();
    if (title === undefined) throw new CliError("missing required flag: --title");
    if (title === "") throw new CliError("title must not be empty");

    const tags = flags.has("--tags")
      ? [...new Set(flags.get("--tags")!.split(",").map(normalizeTag).filter(Boolean))]
      : [];
    const dueValue = flags.get("--due");
    const due = dueValue === undefined ? undefined : requireDate(dueValue, "--due");
    const database = await readDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags,
      ...(due === undefined ? {} : { due }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await writeDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      throw new CliError("--status must be open or done");
    }
    const tagValue = flags.get("--tag");
    const tag = tagValue === undefined ? undefined : normalizeTag(tagValue);
    if (tag === "") throw new CliError("--tag must not be empty");
    const overdueValue = flags.get("--overdue");
    const overdue = overdueValue === undefined ? undefined : requireDate(overdueValue, "--overdue");

    const database = await readDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1) throw new CliError("usage: done ID");
    const id = parseId(rest[0]);
    const database = await readDatabase();
    const task = findTask(database, id);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await writeDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) throw new CliError("usage: delete ID");
    const id = parseId(rest[0]);
    const database = await readDatabase();
    const task = findTask(database, id);
    database.tasks = database.tasks.filter((candidate) => candidate.id !== id);
    await writeDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) throw new CliError("stats does not accept arguments");
    const database = await readDatabase();
    const today = localDate();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length;
    return { total: database.tasks.length, open, done, overdue };
  }

  throw new CliError(`unknown command: ${command}`);
}

try {
  const result = await execute(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`taskboard: ${message}\n`);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
}
