import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

const databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function requireDate(value: string, label: string): string {
  if (!isDate(value)) fail(`${label} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string" && tag !== "")) {
    return false;
  }
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) return false;
  if (value.status === "done" && value.completedAt === undefined) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  return true;
}

function emptyDatabase(): Database {
  return { version: 1, nextId: 1, tasks: [] };
}

function readDatabase(): Database {
  if (!existsSync(databasePath)) return emptyDatabase();

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(databasePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read database: ${detail}`);
  }

  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.nextId) ||
    (value.nextId as number) < 1 ||
    !Array.isArray(value.tasks) ||
    !value.tasks.every(validateTask)
  ) {
    fail("database has an invalid structure");
  }

  const database = value as unknown as Database;
  const ids = database.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) fail("database contains duplicate task ids");
  const maxId = ids.length === 0 ? 0 : Math.max(...ids);
  if (database.nextId <= maxId) fail("database nextId is invalid");
  return database;
}

function writeDatabase(database: Database): void {
  const directory = dirname(databasePath);
  const temporary = `${databasePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, databasePath);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Preserve the original write error.
    }
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot write database in ${directory}: ${detail}`);
  }
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseTags(value: string): string[] {
  const tags = value.split(",").map(normalizeTag).filter(Boolean);
  return [...new Set(tags)];
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag.startsWith("--")) fail(`unexpected argument: ${flag}`);
    if (!allowed.has(flag)) fail(`unknown flag: ${flag}`);
    if (result.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    result.set(flag, value);
    index += 1;
  }
  return result;
}

function requireId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a safe positive integer");
  return id;
}

function findTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`task ${id} not found`);
  return task;
}

function commandAdd(args: string[]): Task {
  const flags = parseFlags(args, new Set(["--title", "--tags", "--due"]));
  const rawTitle = flags.get("--title");
  if (rawTitle === undefined) fail("missing required flag: --title");
  const title = rawTitle.trim();
  if (title === "") fail("title must not be empty");

  const dueValue = flags.get("--due");
  const due = dueValue === undefined ? undefined : requireDate(dueValue, "due date");
  const database = readDatabase();
  const task: Task = {
    id: database.nextId,
    title,
    status: "open",
    createdAt: new Date().toISOString(),
    tags: parseTags(flags.get("--tags") ?? ""),
    ...(due === undefined ? {} : { due }),
  };
  database.nextId += 1;
  database.tasks.push(task);
  writeDatabase(database);
  return task;
}

function commandList(args: string[]): Task[] {
  const flags = parseFlags(args, new Set(["--status", "--tag", "--overdue"]));
  const status = flags.get("--status");
  if (status !== undefined && status !== "open" && status !== "done") {
    fail("status must be open or done");
  }
  const rawTag = flags.get("--tag");
  const tag = rawTag === undefined ? undefined : normalizeTag(rawTag);
  if (rawTag !== undefined && tag === "") fail("tag must not be empty");
  const rawOverdue = flags.get("--overdue");
  const overdue = rawOverdue === undefined ? undefined : requireDate(rawOverdue, "overdue date");

  return readDatabase().tasks
    .filter((task) => status === undefined || task.status === status)
    .filter((task) => tag === undefined || task.tags.includes(tag))
    .filter(
      (task) =>
        overdue === undefined ||
        (task.status === "open" && task.due !== undefined && task.due < overdue),
    )
    .sort((left, right) => left.id - right.id);
}

function commandDone(args: string[]): Task {
  if (args.length !== 1) fail("usage: done ID");
  const database = readDatabase();
  const task = findTask(database, requireId(args[0]));
  if (task.status === "open") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    writeDatabase(database);
  }
  return task;
}

function commandDelete(args: string[]): Task {
  if (args.length !== 1) fail("usage: delete ID");
  const database = readDatabase();
  const task = findTask(database, requireId(args[0]));
  database.tasks = database.tasks.filter((candidate) => candidate.id !== task.id);
  writeDatabase(database);
  return task;
}

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function commandStats(args: string[]): { total: number; open: number; done: number; overdue: number } {
  if (args.length !== 0) fail("usage: stats");
  const tasks = readDatabase().tasks;
  const today = localToday();
  return {
    total: tasks.length,
    open: tasks.filter((task) => task.status === "open").length,
    done: tasks.filter((task) => task.status === "done").length,
    overdue: tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length,
  };
}

function run(args: string[]): unknown {
  const [command, ...rest] = args;
  switch (command) {
    case "add":
      return commandAdd(rest);
    case "list":
      return commandList(rest);
    case "done":
      return commandDone(rest);
    case "delete":
      return commandDelete(rest);
    case "stats":
      return commandStats(rest);
    case undefined:
      fail("missing command");
    default:
      fail(`unknown command: ${command}`);
  }
}

try {
  console.log(JSON.stringify(run(process.argv.slice(2))));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(message);
  process.exitCode = 1;
}
