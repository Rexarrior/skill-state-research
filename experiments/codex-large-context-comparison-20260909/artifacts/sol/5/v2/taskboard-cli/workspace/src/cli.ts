import { rename, unlink, writeFile } from "node:fs/promises";
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

const databasePath = process.env.TASKBOARD_FILE || join(process.cwd(), ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function requireDate(value: string, name: string): string {
  if (!isDate(value)) fail(`${name} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function normalizeTag(value: string): string {
  const tag = value.trim().toLowerCase();
  if (!tag) fail("tags must not be empty");
  return tag;
}

function normalizeTags(value: string): string[] {
  if (!value.trim()) return [];
  return [...new Set(value.split(",").map(normalizeTag))];
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || !value.title.trim()) return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || !tag || tag !== normalizeStoredTag(tag))) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && (typeof value.due !== "string" || !isDate(value.due))) return false;
  if (value.completedAt !== undefined && (typeof value.completedAt !== "string" || Number.isNaN(Date.parse(value.completedAt)))) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && typeof value.completedAt !== "string") return false;
  return true;
}

function normalizeStoredTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("malformed taskboard database");
  }
  if (Object.keys(value).some((key) => !["version", "nextId", "tasks"].includes(key))) fail("malformed taskboard database");
  if (!value.tasks.every(validateTask)) fail("malformed taskboard database");
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (value.nextId as number))) fail("malformed taskboard database");
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  try {
    return validateDatabase(JSON.parse(text));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("malformed taskboard database");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const temporaryPath = join(dirname(databasePath), `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseFlags(args: string[], allowed: Set<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name?.startsWith("--")) fail(`unexpected argument: ${name ?? ""}`);
    if (!allowed.has(name)) fail(`unknown flag: ${name}`);
    if (flags.has(name)) fail(`duplicate flag: ${name}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${name}`);
    flags.set(name, value);
  }
  return flags;
}

function parseId(args: string[], command: string): number {
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0])) fail(`usage: ${command} ID`);
  const id = Number(args[0]);
  if (!Number.isSafeInteger(id)) fail("ID is outside the supported integer range");
  return id;
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
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
    const due = flags.has("--due") ? requireDate(flags.get("--due")!, "--due") : undefined;
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: flags.has("--tags") ? normalizeTags(flags.get("--tags")!) : [],
      ...(due === undefined ? {} : { due }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
    const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
    const overdue = flags.has("--overdue") ? requireDate(flags.get("--overdue")!, "--overdue") : undefined;
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    const id = parseId(rest, "done");
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
    const id = parseId(rest, "delete");
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`task ${id} not found`);
    const [deleted] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return deleted;
  }

  if (command === "stats") {
    if (rest.length) fail(`unknown flag or argument: ${rest[0]}`);
    const tasks = (await loadDatabase()).tasks;
    const today = localToday();
    return {
      total: tasks.length,
      open: tasks.filter((task) => task.status === "open").length,
      done: tasks.filter((task) => task.status === "done").length,
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
  console.error(`taskboard: ${message}`);
  process.exitCode = 1;
}
