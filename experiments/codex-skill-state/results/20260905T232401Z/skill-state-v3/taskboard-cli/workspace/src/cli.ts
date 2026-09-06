import { readFile, rename, writeFile } from "node:fs/promises";
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function validateTask(value: unknown): value is Task {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoInstant(value.createdAt)) return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.tags.some((tag) => tag === "" || tag !== normalizeTag(tag))) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (value.completedAt !== undefined && !isIsoInstant(value.completedAt)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && value.completedAt === undefined) return false;
  return true;
}

function validateDatabase(value: unknown): value is Database {
  if (!isObject(value)) return false;
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
    if (isObject(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new CliError(`Malformed database: ${databasePath}`);
  }
  if (!validateDatabase(parsed)) throw new CliError(`Malformed database: ${databasePath}`);
  return parsed;
}

async function saveDatabase(database: Database): Promise<void> {
  const temporary = join(
    dirname(databasePath),
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, databasePath);
  } catch (error) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(temporary);
    } catch {}
    throw error;
  }
}

function normalizeTag(tag: string): string {
  return tag.trim().toLocaleLowerCase();
}

function requireDate(value: string, flag: string): string {
  if (!isDate(value)) throw new CliError(`${flag} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new CliError("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new CliError("ID must be a positive integer");
  return id;
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) throw new CliError(`Unknown flag: ${flag ?? ""}`);
    if (flags.has(flag)) throw new CliError(`Duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError(`Missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function findTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new CliError(`Task ${id} not found`);
  return task;
}

function localDate(today = new Date()): string {
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function execute(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) throw new CliError("Missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title")?.trim();
    if (!title) throw new CliError("--title is required and cannot be empty");
    const tags = [...new Set((flags.get("--tags") ?? "").split(",").map(normalizeTag).filter(Boolean))];
    const dueValue = flags.get("--due");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags,
      ...(dueValue === undefined ? {} : { due: requireDate(dueValue, "--due") }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      throw new CliError("--status must be open or done");
    }
    const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
    if (tag === "") throw new CliError("--tag cannot be empty");
    const overdue = flags.has("--overdue") ? requireDate(flags.get("--overdue")!, "--overdue") : undefined;
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    if (rest.length !== 1) throw new CliError("Usage: done ID");
    const database = await loadDatabase();
    const task = findTask(database, parseId(rest[0]));
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) throw new CliError("Usage: delete ID");
    const database = await loadDatabase();
    const task = findTask(database, parseId(rest[0]));
    database.tasks = database.tasks.filter((candidate) => candidate.id !== task.id);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) throw new CliError(`Unknown flag: ${rest[0]}`);
    const database = await loadDatabase();
    const today = localDate();
    return {
      total: database.tasks.length,
      open: database.tasks.filter((task) => task.status === "open").length,
      done: database.tasks.filter((task) => task.status === "done").length,
      overdue: database.tasks.filter(
        (task) => task.status === "open" && task.due !== undefined && task.due < today,
      ).length,
    };
  }

  throw new CliError(`Unknown command: ${command}`);
}

try {
  const result = await execute(process.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(`taskboard: ${message}`);
  process.exitCode = 1;
}
