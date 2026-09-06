import { rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

type Status = "open" | "done";

export interface Task {
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

const dbPath = () => process.env.TASKBOARD_FILE || join(process.cwd(), ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function requireDate(value: string, label: string): string {
  if (!isDate(value)) fail(`${label} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function validateTask(value: unknown): value is Task {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["id", "title", "status", "tags", "due", "createdAt", "completedAt"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "")) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return false;
  if (value.completedAt !== undefined && (typeof value.completedAt !== "string" || Number.isNaN(Date.parse(value.completedAt)))) return false;
  if (value.status === "done" && value.completedAt === undefined) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  return true;
}

function validateDatabase(value: unknown): value is Database {
  if (!isObject(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) return false;
  if (Object.keys(value).some((key) => !["version", "nextId", "tasks"].includes(key))) return false;
  if (!value.tasks.every(validateTask)) return false;
  const ids = value.tasks.map((task) => task.id);
  return new Set(ids).size === ids.length && ids.every((id) => id < (value.nextId as number));
}

async function loadDatabase(path: string): Promise<Database> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { version: 1, nextId: 1, tasks: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    fail(`database is malformed: ${path}`);
  }
  if (!validateDatabase(parsed)) fail(`database has an invalid structure: ${path}`);
  return parsed;
}

async function saveDatabase(path: string, database: Database): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await Bun.write(temporary, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function parseOptions(args: string[], allowed: Set<string>): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) fail(`unknown flag: ${flag ?? ""}`);
    if (options.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    options.set(flag, value);
  }
  return options;
}

function noArguments(args: string[], command: string): void {
  if (args.length > 0) fail(`${command} does not accept arguments`);
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function normalizeTags(value: string | undefined): string[] {
  if (value === undefined) return [];
  const tags = value.split(",").map((tag) => tag.trim().toLowerCase());
  if (tags.some((tag) => tag === "")) fail("tags must be a comma-separated list of non-empty values");
  return [...new Set(tags)];
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function execute(argv: string[]): Promise<unknown> {
  const [command, ...args] = argv;
  if (!command) fail("missing command");
  const path = dbPath();
  const database = await loadDatabase(path);

  if (command === "add") {
    const options = parseOptions(args, new Set(["--title", "--tags", "--due"]));
    const title = options.get("--title")?.trim();
    if (!title) fail("--title is required and must not be empty");
    const dueValue = options.get("--due");
    const task: Task = {
      id: database.nextId++,
      title,
      status: "open",
      tags: normalizeTags(options.get("--tags")),
      ...(dueValue === undefined ? {} : { due: requireDate(dueValue, "--due") }),
      createdAt: new Date().toISOString(),
    };
    database.tasks.push(task);
    await saveDatabase(path, database);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(args, new Set(["--status", "--tag", "--overdue"]));
    const status = options.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
    const tag = options.get("--tag")?.trim().toLowerCase();
    if (options.has("--tag") && !tag) fail("--tag must not be empty");
    const overdueValue = options.get("--overdue");
    const overdue = overdueValue === undefined ? undefined : requireDate(overdueValue, "--overdue");
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    if (args.length !== 1) fail("usage: done ID");
    const id = parseId(args[0]);
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(path, database);
    }
    return task;
  }

  if (command === "delete") {
    if (args.length !== 1) fail("usage: delete ID");
    const id = parseId(args[0]);
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index < 0) fail(`task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(path, database);
    return task;
  }

  if (command === "stats") {
    noArguments(args, command);
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open");
    return {
      total: database.tasks.length,
      open: open.length,
      done: database.tasks.length - open.length,
      overdue: open.filter((task) => task.due !== undefined && task.due < today).length,
    };
  }

  fail(`unknown command: ${command}`);
}

async function main(): Promise<void> {
  try {
    console.log(JSON.stringify(await execute(Bun.argv.slice(2))));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ error: message }));
    console.error(`taskboard: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
