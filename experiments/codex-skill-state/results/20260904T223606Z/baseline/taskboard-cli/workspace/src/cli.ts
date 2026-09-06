import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  tags: string[];
  status: Status;
  createdAt: string;
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

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseTags(value: string): string[] {
  return [...new Set(value.split(",").map(normalizeTag).filter(Boolean))];
}

function parseId(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear().toString().padStart(4, "0")}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
}

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  if (!Number.isSafeInteger(task.id) || (task.id as number) < 1 || typeof task.title !== "string" || !task.title.trim()) return false;
  if (task.status !== "open" && task.status !== "done") return false;
  if (typeof task.createdAt !== "string" || Number.isNaN(Date.parse(task.createdAt))) return false;
  if (!Array.isArray(task.tags) || !task.tags.every((tag) => typeof tag === "string" && tag === normalizeTag(tag) && tag.length > 0)) return false;
  if (new Set(task.tags).size !== task.tags.length) return false;
  if (task.due !== undefined && (typeof task.due !== "string" || !isDate(task.due))) return false;
  if (task.completedAt !== undefined && (typeof task.completedAt !== "string" || Number.isNaN(Date.parse(task.completedAt)))) return false;
  return (task.status === "done") === (typeof task.completedAt === "string");
}

async function loadDatabase(): Promise<Database> {
  if (!existsSync(databasePath)) return { version: 1, nextId: 1, tasks: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.file(databasePath).text());
  } catch {
    fail(`Malformed database: ${databasePath}`);
  }
  if (!parsed || typeof parsed !== "object") fail(`Malformed database: ${databasePath}`);
  const db = parsed as Record<string, unknown>;
  if (db.version !== 1 || !Number.isSafeInteger(db.nextId) || (db.nextId as number) < 1 || !Array.isArray(db.tasks) || !db.tasks.every(isTask)) {
    fail(`Malformed database: ${databasePath}`);
  }
  const ids = db.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (db.nextId as number))) fail(`Malformed database: ${databasePath}`);
  return db as Database;
}

async function saveDatabase(db: Database): Promise<void> {
  const temporaryPath = `${databasePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(db, null, 2)}\n`);
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try { if (existsSync(temporaryPath)) await Bun.file(temporaryPath).delete(); } catch { /* best effort */ }
    const reason = error instanceof Error ? error.message : String(error);
    fail(`Could not save database in ${dirname(databasePath)}: ${reason}`);
  }
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
  return value;
}

function parseFlags(args: string[], allowed: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!allowed.includes(flag)) fail(`Unknown flag: ${flag}`);
    if (flags.has(flag)) fail(`Duplicate flag: ${flag}`);
    flags.set(flag, requireValue(args, index, flag));
  }
  return flags;
}

async function run(args: string[]): Promise<unknown> {
  const command = args[0];
  if (!command) fail("Missing command");

  if (command === "add") {
    const flags = parseFlags(args.slice(1), ["--title", "--tags", "--due"]);
    const title = flags.get("--title")?.trim();
    if (!title) fail("A non-empty --title is required");
    const due = flags.get("--due");
    if (due !== undefined && !isDate(due)) fail("--due must be a valid YYYY-MM-DD date");
    const db = await loadDatabase();
    const task: Task = { id: db.nextId++, title, tags: parseTags(flags.get("--tags") || ""), status: "open", createdAt: new Date().toISOString() };
    if (due !== undefined) task.due = due;
    db.tasks.push(task);
    await saveDatabase(db);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(args.slice(1), ["--status", "--tag", "--overdue"]);
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail("--overdue must be a valid YYYY-MM-DD date");
    const tag = flags.get("--tag");
    if (tag !== undefined && !normalizeTag(tag)) fail("--tag must not be empty");
    const db = await loadDatabase();
    return db.tasks.filter((task) =>
      (!status || task.status === status) &&
      (!tag || task.tags.includes(normalizeTag(tag))) &&
      (!overdue || (task.status === "open" && task.due !== undefined && task.due < overdue)),
    ).sort((a, b) => a.id - b.id);
  }

  if (command === "done" || command === "delete") {
    if (args.length !== 2) fail(`${command} requires exactly one ID`);
    const id = parseId(args[1]);
    const db = await loadDatabase();
    const index = db.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`Task not found: ${id}`);
    if (command === "delete") {
      const [deleted] = db.tasks.splice(index, 1);
      await saveDatabase(db);
      return deleted;
    }
    const task = db.tasks[index];
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(db);
    }
    return task;
  }

  if (command === "stats") {
    if (args.length !== 1) fail("stats takes no arguments");
    const db = await loadDatabase();
    const open = db.tasks.filter((task) => task.status === "open");
    return { total: db.tasks.length, open: open.length, done: db.tasks.length - open.length, overdue: open.filter((task) => task.due !== undefined && task.due < today()).length };
  }

  fail(`Unknown command: ${command}`);
}

run(process.argv.slice(2)).then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Unexpected failure"}\n`);
  process.exitCode = 1;
});
