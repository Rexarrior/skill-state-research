import { dirname, basename, join } from "node:path";
import { rename, writeFile } from "node:fs/promises";

type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  status: Status;
  tags: string[];
  due?: string;
  createdAt: string;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || year > 9999) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function assertDate(value: string, label = "date"): string {
  if (!isDate(value)) fail(`Invalid ${label}: expected a real date in YYYY-MM-DD format`);
  return value;
}

function validateTask(value: unknown): value is Task {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["id", "title", "status", "tags", "due", "createdAt", "completedAt"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== tag.toLowerCase())) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (value.status === "done") return isIsoTimestamp(value.completedAt);
  return value.completedAt === undefined;
}

function validateDatabase(value: unknown): value is Database {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("version") || !keys.includes("nextId") || !keys.includes("tasks")) return false;
  if (value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) return false;
  if (!value.tasks.every(validateTask)) return false;
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) return false;
  return ids.every((id) => id < (value.nextId as number));
}

async function loadDatabase(): Promise<Database> {
  const file = Bun.file(databasePath);
  if (!(await file.exists())) return { version: 1, nextId: 1, tasks: [] };
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    fail(`Malformed database: ${databasePath}`);
  }
  if (!validateDatabase(value)) fail(`Malformed database: ${databasePath}`);
  return value;
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporary = join(directory, `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
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

function parseId(args: string[], command: string): number {
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0])) fail(`Usage: ${command} ID`);
  const id = Number(args[0]);
  if (!Number.isSafeInteger(id)) fail("Invalid task ID");
  return id;
}

function normalizedTags(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const tags = raw.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return [...new Set(tags)];
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function execute(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("Missing command");

  if (command === "add") {
    const options = parseOptions(rest, new Set(["--title", "--tags", "--due"]));
    const title = options.get("--title");
    if (title === undefined) fail("Missing required flag: --title");
    if (title.trim() === "") fail("Title must not be empty");
    const due = options.get("--due");
    if (due !== undefined) assertDate(due, "due date");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId++,
      title,
      status: "open",
      tags: normalizedTags(options.get("--tags")),
      ...(due === undefined ? {} : { due }),
      createdAt: new Date().toISOString(),
    };
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = options.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("Invalid status: expected open or done");
    const tag = options.get("--tag")?.trim().toLowerCase();
    if (options.has("--tag") && !tag) fail("Tag must not be empty");
    const overdue = options.get("--overdue");
    if (overdue !== undefined) assertDate(overdue, "overdue date");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    const id = parseId(rest, command);
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
    const id = parseId(rest, command);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`Task not found: ${id}`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`Unknown flag: ${rest[0]}`);
    const tasks = (await loadDatabase()).tasks;
    const today = localToday();
    return {
      total: tasks.length,
      open: tasks.filter((task) => task.status === "open").length,
      done: tasks.filter((task) => task.status === "done").length,
      overdue: tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`Unknown command: ${command}`);
}

try {
  const result = await execute(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(`taskboard: ${message}`);
  process.exitCode = 1;
}
