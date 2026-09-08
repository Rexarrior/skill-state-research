import { dirname, basename, join } from "node:path";
import { rename } from "node:fs/promises";

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
  nextId: number;
  tasks: Task[];
}

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  console.error(`taskboard: ${message}`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (!keys.every((key) => ["id", "title", "status", "tags", "due", "createdAt", "completedAt"].includes(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) return false;
  if (value.due !== undefined && (typeof value.due !== "string" || !isDate(value.due))) return false;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return false;
  if (value.completedAt !== undefined && (typeof value.completedAt !== "string" || Number.isNaN(Date.parse(value.completedAt)))) return false;
  if (value.status === "done" && typeof value.completedAt !== "string") return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  return true;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { nextId: 1, tasks: [] };
    fail(`cannot read database: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("database is malformed JSON");
  }

  if (!isRecord(value) || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks) || !value.tasks.every(isTask)) {
    fail("database has an invalid structure");
  }
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (value.nextId as number))) {
    fail("database has invalid task IDs");
  }
  return value as unknown as Database;
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporary = join(directory, `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await Bun.write(temporary, `${JSON.stringify(database, null, 2)}\n`);
    await Bun.file(temporary).exists() || fail("could not create temporary database file");
    await rename(temporary, databasePath);
  } catch (error) {
    try { await Bun.file(temporary).delete(); } catch { /* best effort cleanup */ }
    fail(`cannot write database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseFlags(args: string[], allowed: Set<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) fail(`unknown flag or argument: ${flag ?? ""}`);
    if (flags.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseId(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID is too large");
  return id;
}

function localDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) fail("missing command");

  if (command === "add") {
    const flags = parseFlags(args, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title")?.trim();
    if (!title) fail("--title is required and cannot be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isDate(due)) fail("--due must be a valid YYYY-MM-DD date");
    const tags = flags.has("--tags")
      ? [...new Set(flags.get("--tags")!.split(",").map(normalizeTag).filter(Boolean))]
      : [];
    const database = await loadDatabase();
    const task: Task = { id: database.nextId++, title, status: "open", tags, createdAt: new Date().toISOString() };
    if (due !== undefined) task.due = due;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(args, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
    const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
    if (tag === "") fail("--tag cannot be empty");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail("--overdue must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    if (args.length !== 1) fail("usage: done ID");
    const id = parseId(args[0]);
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
    if (args.length !== 1) fail("usage: delete ID");
    const id = parseId(args[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`task ${id} not found`);
    const [deleted] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return deleted;
  }

  if (command === "stats") {
    if (args.length !== 0) fail(`unknown flag or argument: ${args[0]}`);
    const database = await loadDatabase();
    const today = localDate();
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

try {
  const result = await main();
  console.log(JSON.stringify(result));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
