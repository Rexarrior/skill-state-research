import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";

type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  status: Status;
  createdAt: string;
  completedAt?: string;
  tags: string[];
  due?: string;
}

interface Database {
  tasks: Task[];
}

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || !Array.isArray(value.tasks)) fail("Malformed taskboard database.");
  const ids = new Set<number>();
  const tasks: Task[] = [];
  for (const raw of value.tasks) {
    if (!isRecord(raw) || !Number.isSafeInteger(raw.id) || raw.id <= 0 || ids.has(raw.id) ||
      typeof raw.title !== "string" || raw.title.trim() === "" ||
      (raw.status !== "open" && raw.status !== "done") || !isIsoTimestamp(raw.createdAt) ||
      !Array.isArray(raw.tags) || !raw.tags.every((tag) => typeof tag === "string" && tag === normalizeTag(tag)) ||
      new Set(raw.tags).size !== raw.tags.length ||
      (raw.due !== undefined && !isDate(raw.due)) ||
      (raw.completedAt !== undefined && !isIsoTimestamp(raw.completedAt)) ||
      (raw.status === "done" && raw.completedAt === undefined) ||
      (raw.status === "open" && raw.completedAt !== undefined)) {
      fail("Malformed taskboard database.");
    }
    ids.add(raw.id);
    tasks.push(raw as Task);
  }
  return { tasks };
}

function databasePath(): string {
  return resolve(process.env.TASKBOARD_FILE || ".taskboard.json");
}

function readDatabase(path: string): Database {
  if (!existsSync(path)) return { tasks: [] };
  try {
    return validateDatabase(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("Malformed taskboard database.");
  }
}

function writeDatabase(path: string, database: Database): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort only */ }
    throw error;
  }
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function tagsFrom(value: string): string[] {
  const tags = value.split(",").map(normalizeTag);
  if (tags.some((tag) => tag === "")) fail("Tags must not be empty.");
  return [...new Set(tags)];
}

function today(): string {
  const now = new Date();
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function options(args: string[], allowed: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.includes(flag)) fail(`Unknown flag: ${flag}`);
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}.`);
    if (parsed.has(flag)) fail(`Duplicate flag: ${flag}`);
    parsed.set(flag, value);
  }
  return parsed;
}

function idFrom(args: string[]): number {
  if (args.length !== 1 || !/^\d+$/.test(args[0])) fail("Expected one positive integer task ID.");
  const id = Number(args[0]);
  if (!Number.isSafeInteger(id) || id <= 0) fail("Expected one positive integer task ID.");
  return id;
}

function execute(args: string[]): unknown {
  const [command, ...rest] = args;
  if (!command) fail("Missing command.");
  const path = databasePath();
  const database = readDatabase(path);

  if (command === "add") {
    const parsed = options(rest, ["--title", "--tags", "--due"]);
    const title = parsed.get("--title");
    if (title === undefined || title.trim() === "") fail("A non-empty --title is required.");
    const due = parsed.get("--due");
    if (due !== undefined && !isDate(due)) fail("Invalid due date. Use YYYY-MM-DD.");
    const task: Task = { id: Math.max(0, ...database.tasks.map((item) => item.id)) + 1, title, status: "open", createdAt: new Date().toISOString(), tags: parsed.has("--tags") ? tagsFrom(parsed.get("--tags")!) : [] };
    if (due !== undefined) task.due = due;
    database.tasks.push(task);
    writeDatabase(path, database);
    return task;
  }

  if (command === "list") {
    const parsed = options(rest, ["--status", "--tag", "--overdue"]);
    const status = parsed.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done.");
    const tag = parsed.get("--tag");
    if (tag !== undefined && normalizeTag(tag) === "") fail("--tag must not be empty.");
    const overdue = parsed.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail("Invalid overdue date. Use YYYY-MM-DD.");
    return database.tasks.filter((task) =>
      (status === undefined || task.status === status) &&
      (tag === undefined || task.tags.includes(normalizeTag(tag))) &&
      (overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue)),
    ).sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    const id = idFrom(rest);
    const task = database.tasks.find((item) => item.id === id);
    if (!task) fail(`Task ${id} does not exist.`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      writeDatabase(path, database);
    }
    return task;
  }

  if (command === "delete") {
    const id = idFrom(rest);
    const index = database.tasks.findIndex((item) => item.id === id);
    if (index === -1) fail(`Task ${id} does not exist.`);
    const [task] = database.tasks.splice(index, 1);
    writeDatabase(path, database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail("stats does not accept arguments.");
    const overdue = database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today()).length;
    const done = database.tasks.filter((task) => task.status === "done").length;
    return { total: database.tasks.length, open: database.tasks.length - done, done, overdue };
  }
  fail(`Unknown command: ${command}`);
}

try {
  console.log(JSON.stringify(execute(process.argv.slice(2))));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unexpected error.";
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
