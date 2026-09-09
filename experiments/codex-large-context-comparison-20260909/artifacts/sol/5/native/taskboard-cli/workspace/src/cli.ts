import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

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

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

function validateDate(value: string, name: string): string {
  if (!isDate(value)) fail(`${name} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const tag = normalizeTag(raw);
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
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) return false;
  const tags = value.tags as string[];
  if (tags.some((tag) => tag === "" || tag !== normalizeTag(tag))) return false;
  if (new Set(tags).size !== tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (value.status === "done") {
    if (!isIsoTimestamp(value.completedAt)) return false;
  } else if (value.completedAt !== undefined) {
    return false;
  }
  return true;
}

function validateDatabase(value: unknown): value is Database {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !["version", "nextId", "tasks"].includes(key))) return false;
  if (value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) return false;
  if (!Array.isArray(value.tasks) || !value.tasks.every(validateTask)) return false;
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) return false;
  return ids.every((id) => id < (value.nextId as number));
}

async function loadDatabase(): Promise<Database> {
  let contents: string;
  try {
    contents = await readFile(databasePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    fail(`cannot read database: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail("database contains malformed JSON");
  }
  if (!validateDatabase(parsed)) fail("database has an invalid structure");
  return parsed;
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporary = join(
    directory,
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, databasePath);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    fail(`cannot write database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseFlags(args: string[], allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  const allowedSet = new Set(allowed);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--")) fail(`unexpected argument: ${flag ?? ""}`);
    const name = flag.slice(2);
    if (!allowedSet.has(name)) fail(`unknown flag: ${flag}`);
    if (result.has(name)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    result.set(name, value);
  }
  return result;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function findTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`task ${id} does not exist`);
  return task;
}

async function add(args: string[]): Promise<Task> {
  const flags = parseFlags(args, ["title", "tags", "due"]);
  const title = flags.get("title");
  if (title === undefined) fail("missing required flag: --title");
  if (title.trim() === "") fail("title must not be empty");
  const database = await loadDatabase();
  if (database.nextId === Number.MAX_SAFE_INTEGER) fail("task ID limit reached");
  const task: Task = {
    id: database.nextId,
    title,
    status: "open",
    createdAt: new Date().toISOString(),
    tags: flags.has("tags") ? normalizeTags(flags.get("tags")!) : [],
  };
  const due = flags.get("due");
  if (due !== undefined) task.due = validateDate(due, "due date");
  database.nextId += 1;
  database.tasks.push(task);
  await saveDatabase(database);
  return task;
}

async function list(args: string[]): Promise<Task[]> {
  const flags = parseFlags(args, ["status", "tag", "overdue"]);
  const status = flags.get("status");
  if (status !== undefined && status !== "open" && status !== "done") {
    fail("status must be open or done");
  }
  const tag = flags.has("tag") ? normalizeTag(flags.get("tag")!) : undefined;
  if (tag === "") fail("tag must not be empty");
  const overdue = flags.get("overdue");
  if (overdue !== undefined) validateDate(overdue, "overdue date");
  const database = await loadDatabase();
  return database.tasks
    .filter((task) => status === undefined || task.status === status)
    .filter((task) => tag === undefined || task.tags.includes(tag))
    .filter(
      (task) =>
        overdue === undefined ||
        (task.status === "open" && task.due !== undefined && task.due < overdue),
    )
    .sort((left, right) => left.id - right.id);
}

async function done(args: string[]): Promise<Task> {
  if (args.length !== 1) fail("usage: done ID");
  const id = parseId(args[0]);
  const database = await loadDatabase();
  const task = findTask(database, id);
  if (task.status === "open") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    await saveDatabase(database);
  }
  return task;
}

async function remove(args: string[]): Promise<Task> {
  if (args.length !== 1) fail("usage: delete ID");
  const id = parseId(args[0]);
  const database = await loadDatabase();
  const task = findTask(database, id);
  database.tasks = database.tasks.filter((candidate) => candidate.id !== id);
  await saveDatabase(database);
  return task;
}

function todayLocal(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function stats(args: string[]): Promise<{ total: number; open: number; done: number; overdue: number }> {
  if (args.length !== 0) fail("usage: stats");
  const tasks = (await loadDatabase()).tasks;
  const today = todayLocal();
  return {
    total: tasks.length,
    open: tasks.filter((task) => task.status === "open").length,
    done: tasks.filter((task) => task.status === "done").length,
    overdue: tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length,
  };
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  switch (command) {
    case "add":
      return add(rest);
    case "list":
      return list(rest);
    case "done":
      return done(rest);
    case "delete":
      return remove(rest);
    case "stats":
      return stats(rest);
    case undefined:
      fail("missing command");
    default:
      fail(`unknown command: ${command}`);
  }
}

try {
  const output = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
}
