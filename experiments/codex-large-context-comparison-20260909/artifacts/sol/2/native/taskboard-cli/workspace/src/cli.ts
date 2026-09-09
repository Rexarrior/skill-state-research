import { dirname, basename, join } from "node:path";
import { rename, readFile, unlink, writeFile } from "node:fs/promises";

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

const args = process.argv.slice(2);
const databasePath = Object.prototype.hasOwnProperty.call(process.env, "TASKBOARD_FILE")
  ? process.env.TASKBOARD_FILE!
  : join(process.cwd(), ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function validateDatabase(value: unknown): Database {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("Malformed taskboard database");
  }

  const ids = new Set<number>();
  let highestId = 0;
  for (const candidate of value.tasks) {
    if (!isPlainObject(candidate)) fail("Malformed taskboard database");
    const keys = Object.keys(candidate);
    if (keys.some((key) => !["id", "title", "status", "createdAt", "tags", "due", "completedAt"].includes(key))) {
      fail("Malformed taskboard database");
    }

    const id = candidate.id;
    const status = candidate.status;
    if (
      !Number.isSafeInteger(id) ||
      (id as number) < 1 ||
      ids.has(id as number) ||
      typeof candidate.title !== "string" ||
      candidate.title.trim() === "" ||
      (status !== "open" && status !== "done") ||
      !isIsoTimestamp(candidate.createdAt) ||
      !Array.isArray(candidate.tags) ||
      candidate.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== tag.trim().toLowerCase()) ||
      new Set(candidate.tags).size !== candidate.tags.length ||
      (candidate.due !== undefined && !isDate(candidate.due)) ||
      (candidate.completedAt !== undefined && !isIsoTimestamp(candidate.completedAt)) ||
      (status === "open" && candidate.completedAt !== undefined) ||
      (status === "done" && candidate.completedAt === undefined)
    ) {
      fail("Malformed taskboard database");
    }
    ids.add(id as number);
    highestId = Math.max(highestId, id as number);
  }

  if ((value.nextId as number) <= highestId) fail("Malformed taskboard database");
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  if (databasePath.length === 0) fail("TASKBOARD_FILE must not be empty");
  let contents: string;
  try {
    contents = await readFile(databasePath, "utf8");
  } catch (error) {
    if (isPlainObject(error) && error.code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }

  try {
    return validateDatabase(JSON.parse(contents));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("Malformed taskboard database");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = join(
    directory,
    `.${basename(databasePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    throw error;
  }
}

function parseFlags(tokens: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    if (!flag.startsWith("--")) fail(`Unexpected argument: ${flag}`);
    if (!allowed.has(flag)) fail(`Unknown flag: ${flag}`);
    if (result.has(flag)) fail(`Duplicate flag: ${flag}`);
    if (index + 1 >= tokens.length) fail(`Missing value for ${flag}`);
    result.set(flag, tokens[index + 1]);
  }
  return result;
}

function normalizeTag(tag: string): string {
  const normalized = tag.trim().toLowerCase();
  if (normalized === "") fail("Tag must not be empty");
  return normalized;
}

function parseTags(value: string | undefined): string[] {
  if (value === undefined) return [];
  const tags = value.split(",").map(normalizeTag);
  return [...new Set(tags)];
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail("ID must be a positive integer");
  return id;
}

function requireDate(value: string, label: string): string {
  if (!isDate(value)) fail(`${label} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(): Promise<unknown> {
  const [command, ...rest] = args;
  if (command === undefined) fail("Missing command");

  switch (command) {
    case "add": {
      const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
      const titleValue = flags.get("--title");
      if (titleValue === undefined) fail("Missing required flag: --title");
      const title = titleValue.trim();
      if (title === "") fail("Title must not be empty");
      const dueValue = flags.get("--due");
      const database = await loadDatabase();
      const task: Task = {
        id: database.nextId,
        title,
        status: "open",
        createdAt: new Date().toISOString(),
        tags: parseTags(flags.get("--tags")),
      };
      if (dueValue !== undefined) task.due = requireDate(dueValue, "Due date");
      database.tasks.push(task);
      database.nextId += 1;
      await saveDatabase(database);
      return task;
    }

    case "list": {
      const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
      const status = flags.get("--status");
      if (status !== undefined && status !== "open" && status !== "done") {
        fail("Status must be open or done");
      }
      const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
      const overdueValue = flags.get("--overdue");
      const overdue = overdueValue === undefined ? undefined : requireDate(overdueValue, "Overdue date");
      const database = await loadDatabase();
      return database.tasks
        .filter((task) => status === undefined || task.status === status)
        .filter((task) => tag === undefined || task.tags.includes(tag))
        .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
        .sort((left, right) => left.id - right.id);
    }

    case "done": {
      if (rest.length !== 1) fail("Usage: done ID");
      const id = parseId(rest[0]);
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

    case "delete": {
      if (rest.length !== 1) fail("Usage: delete ID");
      const id = parseId(rest[0]);
      const database = await loadDatabase();
      const index = database.tasks.findIndex((candidate) => candidate.id === id);
      if (index === -1) fail(`Task ${id} not found`);
      const [task] = database.tasks.splice(index, 1);
      await saveDatabase(database);
      return task;
    }

    case "stats": {
      if (rest.length !== 0) fail(`Unknown flag or argument: ${rest[0]}`);
      const database = await loadDatabase();
      const today = localToday();
      const open = database.tasks.filter((task) => task.status === "open").length;
      const done = database.tasks.length - open;
      const overdue = database.tasks.filter(
        (task) => task.status === "open" && task.due !== undefined && task.due < today,
      ).length;
      return { total: database.tasks.length, open, done, overdue };
    }

    default:
      fail(`Unknown command: ${command}`);
  }
}

try {
  const output = await run();
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.stderr.write(`taskboard: ${message}\n`);
  process.exitCode = 1;
}
