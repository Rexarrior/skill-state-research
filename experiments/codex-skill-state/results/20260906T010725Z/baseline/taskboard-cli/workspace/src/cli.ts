import { rename, unlink } from "node:fs/promises";

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
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const databasePath = process.env.TASKBOARD_FILE ?? ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    fail("Malformed taskboard database: expected an object with a tasks array");
  }

  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) {
    fail("Malformed taskboard database: nextId must be a positive integer");
  }

  const ids = new Set<number>();
  let highestId = 0;

  for (const candidate of value.tasks) {
    if (!isRecord(candidate)) fail("Malformed taskboard database: invalid task");
    const { id, title, status, createdAt, tags, due, completedAt } = candidate;

    if (!Number.isSafeInteger(id) || (id as number) < 1 || ids.has(id as number)) {
      fail("Malformed taskboard database: task ids must be unique positive integers");
    }
    if (typeof title !== "string" || title.trim() === "") {
      fail("Malformed taskboard database: task title must not be empty");
    }
    if (status !== "open" && status !== "done") {
      fail("Malformed taskboard database: invalid task status");
    }
    if (!isIsoTimestamp(createdAt)) {
      fail("Malformed taskboard database: invalid createdAt timestamp");
    }
    if (!Array.isArray(tags)) {
      fail("Malformed taskboard database: tags must be an array");
    }

    const seenTags = new Set<string>();
    for (const tag of tags) {
      if (
        typeof tag !== "string" ||
        tag === "" ||
        tag !== normalizeTag(tag) ||
        seenTags.has(tag)
      ) {
        fail("Malformed taskboard database: tags must be unique and normalized");
      }
      seenTags.add(tag);
    }

    if (due !== undefined && !isDate(due)) {
      fail("Malformed taskboard database: invalid due date");
    }
    if (status === "done" && !isIsoTimestamp(completedAt)) {
      fail("Malformed taskboard database: done task requires completedAt");
    }
    if (status === "open" && completedAt !== undefined) {
      fail("Malformed taskboard database: open task cannot have completedAt");
    }

    ids.add(id as number);
    highestId = Math.max(highestId, id as number);
  }

  if ((value.nextId as number) <= highestId) {
    fail("Malformed taskboard database: nextId must exceed all task ids");
  }

  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let contents: string;
  try {
    contents = await Bun.file(databasePath).text();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { nextId: 1, tasks: [] };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail("Malformed taskboard database: invalid JSON");
  }
  return validateDatabase(parsed);
}

async function saveDatabase(database: Database): Promise<void> {
  const temporaryPath = `${databasePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporaryPath, databasePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseFlags(
  args: string[],
  allowed: ReadonlySet<string>,
): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!allowed.has(flag)) fail(`Unknown flag: ${flag}`);
    if (flags.has(flag)) fail(`Duplicate flag: ${flag}`);
    if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
      fail(`Missing value for ${flag}`);
    }
    flags.set(flag, args[index + 1]);
  }
  return flags;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    fail("ID must be a positive integer");
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a safe positive integer");
  return id;
}

function parseTags(value: string | undefined): string[] {
  if (value === undefined) return [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of value.split(",")) {
    const tag = normalizeTag(rawTag);
    if (tag !== "" && !seen.has(tag)) {
      tags.push(tag);
      seen.add(tag);
    }
  }
  return tags;
}

function localDate(date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function add(args: string[]): Promise<Task> {
  const flags = parseFlags(args, new Set(["--title", "--tags", "--due"]));
  if (!flags.has("--title")) fail("Missing required flag: --title");

  const title = flags.get("--title")!.trim();
  if (title === "") fail("Title must not be empty");
  const due = flags.get("--due");
  if (due !== undefined && !isDate(due)) fail("Due date must be a valid YYYY-MM-DD date");

  const database = await loadDatabase();
  if (database.nextId === Number.MAX_SAFE_INTEGER) {
    fail("Cannot add task: integer id space exhausted");
  }
  const task: Task = {
    id: database.nextId,
    title,
    status: "open",
    createdAt: new Date().toISOString(),
    tags: parseTags(flags.get("--tags")),
    ...(due === undefined ? {} : { due }),
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
    fail("Status must be open or done");
  }
  const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
  if (tag === "") fail("Tag must not be empty");
  const overdue = flags.get("--overdue");
  if (overdue !== undefined && !isDate(overdue)) {
    fail("Overdue date must be a valid YYYY-MM-DD date");
  }

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
  if (task === undefined) fail(`Task ${id} not found`);

  if (task.status === "open") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    await saveDatabase(database);
  }
  return task;
}

async function remove(args: string[]): Promise<Task> {
  if (args.length !== 1) fail("Usage: delete ID");
  const id = parseId(args[0]);
  const database = await loadDatabase();
  const index = database.tasks.findIndex((candidate) => candidate.id === id);
  if (index === -1) fail(`Task ${id} not found`);
  const [task] = database.tasks.splice(index, 1);
  await saveDatabase(database);
  return task;
}

async function stats(args: string[]): Promise<Record<string, number>> {
  if (args.length !== 0) fail(`Unknown flag: ${args[0]}`);
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

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  switch (command) {
    case "add":
      return add(rest);
    case "list":
      return list(rest);
    case "done":
      return done(rest);
    case "delete":
      return remove(rest);
    case "stats":
      return stats(rest);
    default:
      fail(command === undefined ? "Missing command" : `Unknown command: ${command}`);
  }
}

try {
  const result = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
