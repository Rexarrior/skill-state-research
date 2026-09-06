import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

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

const databasePath = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysPerMonth[month - 1];
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (
    !Array.isArray(value.tags) ||
    !value.tags.every(
      (tag) => typeof tag === "string" && tag !== "" && tag === normalizeTag(tag),
    )
  ) {
    return false;
  }
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) return false;
  if (value.status === "done" && value.completedAt === undefined) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  return true;
}

function validateDatabase(value: unknown): value is Database {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) return false;
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
    if (isRecord(error) && error.code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail(`Malformed database: ${databasePath}`);
  }

  if (!validateDatabase(parsed)) {
    fail(`Malformed database: ${databasePath}`);
  }
  return parsed;
}

async function saveDatabase(database: Database): Promise<void> {
  const temporaryPath = resolve(
    dirname(databasePath),
    `.${basename(databasePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryCreated = false;

  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(`${JSON.stringify(database, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, databasePath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseFlags(
  args: string[],
  allowed: ReadonlySet<string>,
): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name?.startsWith("--")) fail(`Unexpected argument: ${name ?? ""}`);
    if (!allowed.has(name)) fail(`Unknown flag: ${name}`);
    if (flags.has(name)) fail(`Duplicate flag: ${name}`);

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${name}`);
    flags.set(name, value);
  }
  return flags;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function requireDate(value: string, flag: string): string {
  if (!isDate(value)) fail(`${flag} must be a valid date in YYYY-MM-DD format`);
  return value;
}

async function add(args: string[]): Promise<Task> {
  const flags = parseFlags(args, new Set(["--title", "--tags", "--due"]));
  const title = flags.get("--title")?.trim();
  if (!title) fail("--title is required and must not be empty");

  const tags = flags.has("--tags")
    ? [...new Set(flags.get("--tags")!.split(",").map(normalizeTag).filter(Boolean))]
    : [];
  const dueValue = flags.get("--due");
  const due = dueValue === undefined ? undefined : requireDate(dueValue, "--due");
  const database = await loadDatabase();
  if (!Number.isSafeInteger(database.nextId + 1)) fail("No more task IDs are available");
  const task: Task = {
    id: database.nextId,
    title,
    status: "open",
    tags,
    ...(due === undefined ? {} : { due }),
    createdAt: new Date().toISOString(),
  };

  database.nextId += 1;
  database.tasks.push(task);
  await saveDatabase(database);
  return task;
}

async function list(args: string[]): Promise<Task[]> {
  const flags = parseFlags(args, new Set(["--status", "--tag", "--overdue"]));
  const status = flags.get("--status");
  if (status !== undefined && status !== "open" && status !== "done") {
    fail("--status must be open or done");
  }

  const rawTag = flags.get("--tag");
  const tag = rawTag === undefined ? undefined : normalizeTag(rawTag);
  if (rawTag !== undefined && tag === "") fail("--tag must not be empty");

  const overdueValue = flags.get("--overdue");
  const overdue = overdueValue === undefined ? undefined : requireDate(overdueValue, "--overdue");
  const database = await loadDatabase();

  return database.tasks
    .filter((task) => status === undefined || task.status === status)
    .filter((task) => tag === undefined || task.tags.includes(tag))
    .filter(
      (task) =>
        overdue === undefined ||
        (task.status === "open" && task.due !== undefined && task.due < overdue),
    )
    .sort((left, right) => left.id - right.id);
}

async function done(args: string[]): Promise<Task> {
  if (args.length !== 1) fail("Usage: done ID");
  const id = parseId(args[0]);
  const database = await loadDatabase();
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`Task ${id} not found`);

  if (task.status === "open") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    await saveDatabase(database);
  }
  return task;
}

async function deleteTask(args: string[]): Promise<Task> {
  if (args.length !== 1) fail("Usage: delete ID");
  const id = parseId(args[0]);
  const database = await loadDatabase();
  const index = database.tasks.findIndex((candidate) => candidate.id === id);
  if (index === -1) fail(`Task ${id} not found`);

  const [task] = database.tasks.splice(index, 1);
  await saveDatabase(database);
  return task;
}

function todayLocal(): string {
  const now = new Date();
  const year = now.getFullYear().toString().padStart(4, "0");
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function stats(args: string[]): Promise<{ total: number; open: number; done: number; overdue: number }> {
  if (args.length !== 0) fail(`Unknown flag or argument: ${args[0]}`);
  const database = await loadDatabase();
  const today = todayLocal();
  return {
    total: database.tasks.length,
    open: database.tasks.filter((task) => task.status === "open").length,
    done: database.tasks.filter((task) => task.status === "done").length,
    overdue: database.tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length,
  };
}

async function run(argv: string[]): Promise<unknown> {
  const [command, ...args] = argv;
  switch (command) {
    case "add":
      return add(args);
    case "list":
      return list(args);
    case "done":
      return done(args);
    case "delete":
      return deleteTask(args);
    case "stats":
      return stats(args);
    case undefined:
      fail("Missing command");
    default:
      fail(`Unknown command: ${command}`);
  }
}

if (import.meta.main) {
  try {
    const result = await run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
