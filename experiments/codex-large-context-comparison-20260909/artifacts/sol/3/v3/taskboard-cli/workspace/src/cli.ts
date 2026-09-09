import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";

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
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeTag(tag: string): string {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) fail("tags must not be empty");
  return normalized;
}

function validateTask(value: unknown): Task {
  if (!isRecord(value)) fail("malformed database: invalid task");
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) fail("malformed database: invalid task id");
  if (typeof value.title !== "string" || value.title.trim() === "") fail("malformed database: invalid title");
  if (value.status !== "open" && value.status !== "done") fail("malformed database: invalid status");
  if (!isIsoTimestamp(value.createdAt)) fail("malformed database: invalid createdAt");
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string" && tag !== "" && tag === normalizeTag(tag))) {
    fail("malformed database: invalid tags");
  }
  if (new Set(value.tags).size !== value.tags.length) fail("malformed database: duplicate tags");
  if (value.due !== undefined && !isDate(value.due)) fail("malformed database: invalid due date");
  if (value.status === "done" && !isIsoTimestamp(value.completedAt)) fail("malformed database: done task lacks completedAt");
  if (value.status === "open" && value.completedAt !== undefined) fail("malformed database: open task has completedAt");

  return value as unknown as Task;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("malformed database");
  }
  const tasks = value.tasks.map(validateTask);
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) fail("malformed database: duplicate task ids");
  const maxId = tasks.reduce((max, task) => Math.max(max, task.id), 0);
  if ((value.nextId as number) <= maxId) fail("malformed database: invalid nextId");
  return { version: 1, nextId: value.nextId as number, tasks };
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  try {
    return validateDatabase(JSON.parse(text));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("malformed database: invalid JSON");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const temporaryPath = join(dirname(databasePath), `.${basename(databasePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try { await unlink(temporaryPath); } catch { /* Nothing to clean up. */ }
    throw error;
  }
}

function parseFlags(args: string[], allowed: Set<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag.startsWith("--") || !allowed.has(flag)) fail(`unknown flag: ${flag}`);
    if (flags.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a safe positive integer");
  return id;
}

function requireNoExtra(args: string[], usage: string): void {
  if (args.length !== 1) fail(`usage: ${usage}`);
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
  if (!command) fail("missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title")?.trim();
    if (!title) fail("--title is required and must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isDate(due)) fail("--due must be a valid date in YYYY-MM-DD format");
    const tags = flags.has("--tags")
      ? [...new Set(flags.get("--tags")!.split(",").map(normalizeTag))]
      : [];
    const database = await loadDatabase();
    const task: Task = { id: database.nextId, title, status: "open", createdAt: new Date().toISOString(), tags };
    if (due !== undefined) task.due = due;
    database.tasks.push(task);
    database.nextId++;
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
    const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail("--overdue must be a valid date in YYYY-MM-DD format");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    requireNoExtra(rest, "done ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    requireNoExtra(rest, "delete ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index < 0) fail(`task ${id} not found`);
    const [deleted] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return deleted;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`unknown flag: ${rest[0]}`);
    const tasks = (await loadDatabase()).tasks;
    const today = localToday();
    const open = tasks.filter((task) => task.status === "open").length;
    return {
      total: tasks.length,
      open,
      done: tasks.length - open,
      overdue: tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`unknown command: ${command}`);
}

try {
  const result = await run(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(message);
  process.exitCode = 1;
}
