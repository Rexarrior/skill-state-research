import { dirname, basename, join } from "node:path";
import { rename } from "node:fs/promises";

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

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (!keys.every((key) => ["id", "title", "status", "createdAt", "tags", "due", "completedAt"].includes(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) return false;
  if (value.due !== undefined && (typeof value.due !== "string" || !validDate(value.due))) return false;
  if (value.completedAt !== undefined && (typeof value.completedAt !== "string" || Number.isNaN(Date.parse(value.completedAt)))) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && typeof value.completedAt !== "string") return false;
  return true;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`Malformed database: ${databasePath}`);
  }
  if (!isRecord(value) || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail(`Malformed database: ${databasePath}`);
  }
  if (!value.tasks.every(validateTask)) fail(`Malformed database: ${databasePath}`);
  const tasks = value.tasks as Task[];
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || tasks.some((task) => task.id >= (value.nextId as number))) {
    fail(`Malformed database: ${databasePath}`);
  }
  return { nextId: value.nextId as number, tasks };
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporary = join(directory, `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await Bun.write(temporary, `${JSON.stringify(database, null, 2)}\n`, { createPath: true });
    await rename(temporary, databasePath);
  } catch (error) {
    try { await Bun.file(temporary).delete(); } catch {}
    throw error;
  }
}

function parseOptions(args: string[], allowed: Set<string>): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) fail(`Unknown flag: ${flag ?? ""}`);
    if (options.has(flag)) fail(`Duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    options.set(flag, value);
  }
  return options;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("Missing command");

  if (command === "add") {
    const options = parseOptions(rest, new Set(["--title", "--tags", "--due"]));
    const title = options.get("--title");
    if (title === undefined) fail("Missing required flag: --title");
    if (title.trim() === "") fail("Title must not be empty");
    const due = options.get("--due");
    if (due !== undefined && !validDate(due)) fail("Due date must be a valid YYYY-MM-DD date");
    const rawTags = options.get("--tags");
    const tags = rawTags === undefined
      ? []
      : [...new Set(rawTags.split(",").map(normalizeTag).filter(Boolean))];
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title: title.trim(),
      status: "open",
      createdAt: new Date().toISOString(),
      tags,
      ...(due === undefined ? {} : { due }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = options.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("Status must be open or done");
    const tag = options.get("--tag");
    if (tag !== undefined && normalizeTag(tag) === "") fail("Tag must not be empty");
    const overdue = options.get("--overdue");
    if (overdue !== undefined && !validDate(overdue)) fail("Overdue date must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(normalizeTag(tag)))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .toSorted((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("Usage: done ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`Task not found: ${id}`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("Usage: delete ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`Task not found: ${id}`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`Unknown flag: ${rest[0]}`);
    const database = await loadDatabase();
    const today = localToday();
    return {
      total: database.tasks.length,
      open: database.tasks.filter((task) => task.status === "open").length,
      done: database.tasks.filter((task) => task.status === "done").length,
      overdue: database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`Unknown command: ${command}`);
}

try {
  const result = await run(Bun.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
