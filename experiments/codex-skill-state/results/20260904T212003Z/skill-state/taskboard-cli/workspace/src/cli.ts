import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";

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

const databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function requireDate(value: string, label = "date"): string {
  if (!isValidDate(value)) fail(`Invalid ${label}: expected a real date in YYYY-MM-DD format`);
  return value;
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
  const tags = value.split(",").map(normalizeTag).filter(Boolean);
  return [...new Set(tags)];
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId)
      || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("Malformed taskboard database");
  }

  const ids = new Set<number>();
  let highestId = 0;
  for (const raw of value.tasks) {
    if (!isRecord(raw)
        || !Number.isSafeInteger(raw.id) || (raw.id as number) < 1
        || typeof raw.title !== "string" || raw.title.trim() === ""
        || (raw.status !== "open" && raw.status !== "done")
        || !Array.isArray(raw.tags)
        || raw.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== normalizeTag(tag))
        || new Set(raw.tags).size !== raw.tags.length
        || typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))
        || (raw.due !== undefined && (typeof raw.due !== "string" || !isValidDate(raw.due)))
        || (raw.completedAt !== undefined
          && (typeof raw.completedAt !== "string" || Number.isNaN(Date.parse(raw.completedAt))))
        || (raw.status === "done" && typeof raw.completedAt !== "string")
        || (raw.status === "open" && raw.completedAt !== undefined)) {
      fail("Malformed taskboard database");
    }
    const id = raw.id as number;
    if (ids.has(id)) fail("Malformed taskboard database");
    ids.add(id);
    highestId = Math.max(highestId, id);
  }
  if ((value.nextId as number) <= highestId) fail("Malformed taskboard database");
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    fail(`Cannot read database: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return validateDatabase(JSON.parse(text));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("Malformed taskboard database");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporary = join(
    directory,
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, databasePath);
  } catch (error) {
    try { await unlink(temporary); } catch { /* nothing to clean up */ }
    fail(`Cannot write database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag.startsWith("--") || !allowed.has(flag)) fail(`Unknown flag or argument: ${flag}`);
    if (flags.has(flag)) fail(`Duplicate flag: ${flag}`);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function findTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`Task ${id} not found`);
  return task;
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
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title")?.trim();
    if (!title) fail("--title is required and must not be empty");
    const dueValue = flags.get("--due");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId++,
      title,
      status: "open",
      tags: flags.has("--tags") ? normalizeTags(flags.get("--tags")!) : [],
      ...(dueValue === undefined ? {} : { due: requireDate(dueValue, "due date") }),
      createdAt: new Date().toISOString(),
    };
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("--status must be open or done");
    }
    const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
    if (tag === "") fail("--tag must not be empty");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined) requireDate(overdue, "overdue date");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined
        || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1 || rest[0].startsWith("--")) fail("Usage: done ID");
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
    if (rest.length !== 1 || rest[0].startsWith("--")) fail("Usage: delete ID");
    const database = await loadDatabase();
    const task = findTask(database, parseId(rest[0]));
    database.tasks = database.tasks.filter((candidate) => candidate.id !== task.id);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`Unknown flag or argument: ${rest[0]}`);
    const database = await loadDatabase();
    const today = localToday();
    return {
      total: database.tasks.length,
      open: database.tasks.filter((task) => task.status === "open").length,
      done: database.tasks.filter((task) => task.status === "done").length,
      overdue: database.tasks.filter((task) =>
        task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`Unknown command: ${command}`);
}

try {
  const result = await execute(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
