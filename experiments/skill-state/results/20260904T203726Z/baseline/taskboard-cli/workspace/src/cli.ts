import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

type Status = "open" | "done";

type Task = {
  id: number;
  title: string;
  tags: string[];
  status: Status;
  createdAt: string;
  due?: string;
  completedAt?: string;
};

type Database = {
  nextId: number;
  tasks: Task[];
};

class TaskboardError extends Error {}

function fail(message: string): never {
  throw new TaskboardError(message);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function today(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeTags(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function parseId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail("ID must be a positive integer");
  return id;
}

function validateTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  const validStatus = task.status === "open" || task.status === "done";
  const validTags = Array.isArray(task.tags) && task.tags.every((tag) => typeof tag === "string");
  const validDue = task.due === undefined || (typeof task.due === "string" && isDate(task.due));
  const validCompleted = task.completedAt === undefined || typeof task.completedAt === "string";
  return Number.isSafeInteger(task.id) && (task.id as number) > 0 && typeof task.title === "string" &&
    validTags && validStatus && typeof task.createdAt === "string" && validDue && validCompleted &&
    !(task.status === "open" && task.completedAt !== undefined);
}

function loadDatabase(path: string): Database {
  if (!existsSync(path)) return { nextId: 1, tasks: [] };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("Database is malformed");
  }
  if (!value || typeof value !== "object") fail("Database is malformed");
  const database = value as Record<string, unknown>;
  if (!Number.isSafeInteger(database.nextId) || (database.nextId as number) < 1 || !Array.isArray(database.tasks) ||
    !database.tasks.every(validateTask)) fail("Database is malformed");
  const ids = database.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (database.nextId as number))) {
    fail("Database is malformed");
  }
  return { nextId: database.nextId as number, tasks: database.tasks as Task[] };
}

async function saveDatabase(path: string, database: Database): Promise<void> {
  const temporaryPath = join(dirname(path), `.${Date.now()}-${Math.random().toString(16).slice(2)}.taskboard.tmp`);
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    renameSync(temporaryPath, path);
  } catch (error) {
    try { if (existsSync(temporaryPath)) unlinkSync(temporaryPath); } catch { /* no temporary file to clean up */ }
    throw error;
  }
}

function options(args: string[], allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.includes(flag)) fail(`Unknown flag: ${flag}`);
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    if (result.has(flag)) fail(`Duplicate flag: ${flag}`);
    result.set(flag, value);
  }
  return result;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("A command is required");
  const path = process.env.TASKBOARD_FILE || join(process.cwd(), ".taskboard.json");
  const database = loadDatabase(path);

  if (command === "add") {
    const input = options(rest, ["--title", "--tags", "--due"]);
    const title = input.get("--title")?.trim();
    if (!title) fail("Title cannot be empty");
    const due = input.get("--due");
    if (due !== undefined && !isDate(due)) fail("Due date must be a valid YYYY-MM-DD date");
    const task: Task = { id: database.nextId++, title, tags: normalizeTags(input.get("--tags") || ""), status: "open", createdAt: new Date().toISOString() };
    if (due) task.due = due;
    database.tasks.push(task);
    await saveDatabase(path, database);
    return task;
  }

  if (command === "list") {
    const input = options(rest, ["--status", "--tag", "--overdue"]);
    const status = input.get("--status");
    const overdue = input.get("--overdue");
    if (status !== undefined && status !== "open" && status !== "done") fail("Status must be open or done");
    if (overdue !== undefined && !isDate(overdue)) fail("Overdue date must be a valid YYYY-MM-DD date");
    const tag = input.get("--tag")?.trim().toLowerCase();
    return database.tasks.filter((task) =>
      (!status || task.status === status) && (!tag || task.tags.includes(tag)) &&
      (!overdue || (task.status === "open" && task.due !== undefined && task.due < overdue))
    ).sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("Usage: done ID");
    const task = database.tasks.find((candidate) => candidate.id === parseId(rest[0]));
    if (!task) fail("Task not found");
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(path, database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("Usage: delete ID");
    const id = parseId(rest[0]);
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail("Task not found");
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(path, database);
    return task;
  }

  if (command === "stats") {
    if (rest.length) fail("Usage: stats");
    const open = database.tasks.filter((task) => task.status === "open");
    return { total: database.tasks.length, open: open.length, done: database.tasks.length - open.length, overdue: open.filter((task) => task.due && task.due < today()).length };
  }

  fail(`Unknown command: ${command}`);
}

try {
  console.log(JSON.stringify(await run(Bun.argv.slice(2))));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
