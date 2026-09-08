import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  status: Status;
  tags: string[];
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

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = new Set(Object.keys(value));
  const allowed = new Set(["id", "title", "status", "tags", "createdAt", "due", "completedAt"]);
  if ([...keys].some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "")) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (value.due !== undefined && !isValidDate(value.due)) return false;
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && value.completedAt === undefined) return false;
  return true;
}

function validateDatabase(value: unknown): value is Database {
  if (!isRecord(value)) return false;
  if (value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) return false;
  if (!Array.isArray(value.tasks) || !value.tasks.every(validateTask)) return false;
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) return false;
  return ids.every((id) => id < (value.nextId as number));
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await readFile(databasePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    throw new CliError(`cannot read database: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("malformed database: invalid JSON");
  }
  if (!validateDatabase(parsed)) throw new CliError("malformed database: invalid structure");
  return parsed;
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporary = join(
    directory,
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, databasePath);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Nothing to clean up if creating or renaming the temporary file failed early.
    }
    throw new CliError(`cannot write database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parsePositiveId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new CliError("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new CliError("ID must be a positive integer");
  return id;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseTags(value: string): string[] {
  const tags = value.split(",").map(normalizeTag).filter(Boolean);
  return [...new Set(tags)];
}

function parseFlags(args: string[], allowed: Set<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) {
      throw new CliError(`unknown flag or argument: ${flag ?? ""}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new CliError(`missing value for ${flag}`);
    if (flags.has(flag)) throw new CliError(`duplicate flag: ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function findTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new CliError(`task ${id} not found`);
  return task;
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
  if (!command) throw new CliError("missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const titleValue = flags.get("--title");
    if (titleValue === undefined) throw new CliError("missing required flag: --title");
    const title = titleValue.trim();
    if (!title) throw new CliError("title must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isValidDate(due)) throw new CliError("due date must be a valid YYYY-MM-DD date");

    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      tags: flags.has("--tags") ? parseTags(flags.get("--tags")!) : [],
      createdAt: new Date().toISOString(),
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
    if (status !== undefined && status !== "open" && status !== "done") {
      throw new CliError("status must be open or done");
    }
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isValidDate(overdue)) {
      throw new CliError("overdue date must be a valid YYYY-MM-DD date");
    }
    const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
    if (tag === "") throw new CliError("tag must not be empty");

    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1) throw new CliError("usage: done ID");
    const id = parsePositiveId(rest[0]);
    const database = await loadDatabase();
    const task = findTask(database, id);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) throw new CliError("usage: delete ID");
    const id = parsePositiveId(rest[0]);
    const database = await loadDatabase();
    const task = findTask(database, id);
    database.tasks = database.tasks.filter((candidate) => candidate.id !== id);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) throw new CliError("stats does not accept arguments");
    const database = await loadDatabase();
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length;
    return { total: database.tasks.length, open, done, overdue };
  }

  throw new CliError(`unknown command: ${command}`);
}

try {
  const result = await run(process.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(message);
  process.exitCode = 1;
}
