import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

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

const databasePath = process.env.TASKBOARD_FILE || join(process.cwd(), ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = new Set(Object.keys(value));
  const allowed = ["id", "title", "status", "tags", "due", "createdAt", "completedAt"];
  if ([...keys].some((key) => !allowed.includes(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== tag.trim().toLowerCase())) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (value.due !== undefined && !isValidDate(value.due)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && !isIsoTimestamp(value.completedAt)) return false;
  return true;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("Malformed taskboard database");
  }
  if (!value.tasks.every(validateTask)) fail("Malformed taskboard database");
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (value.nextId as number))) {
    fail("Malformed taskboard database");
  }
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let contents: string;
  try {
    contents = await readFile(databasePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
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
  const temporaryPath = join(
    dirname(databasePath),
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
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

function parseFlags(args: string[], allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !allowed.includes(flag)) fail(`Unknown flag: ${flag ?? ""}`);
    if (result.has(flag)) fail(`Duplicate flag: ${flag}`);
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    result.set(flag, value);
  }
  return result;
}

function requireNoFlagsOrExtras(args: string[], usage: string): void {
  if (args.length !== 0) fail(`Usage: ${usage}`);
}

function normalizeTags(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [...new Set(value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function parseDate(value: string, flag: string): string {
  if (!isValidDate(value)) fail(`Invalid date for ${flag}: ${value}`);
  return value;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail(`Invalid task ID: ${value ?? ""}`);
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail(`Invalid task ID: ${value}`);
  return id;
}

function findTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`Task not found: ${id}`);
  return task;
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
  if (!command) fail("Missing command");

  switch (command) {
    case "add": {
      const flags = parseFlags(rest, ["--title", "--tags", "--due"]);
      const rawTitle = flags.get("--title");
      if (rawTitle === undefined) fail("Missing required flag: --title");
      const title = rawTitle.trim();
      if (title === "") fail("Title must not be empty");
      const dueValue = flags.get("--due");
      const database = await loadDatabase();
      const task: Task = {
        id: database.nextId,
        title,
        status: "open",
        tags: normalizeTags(flags.get("--tags")),
        ...(dueValue === undefined ? {} : { due: parseDate(dueValue, "--due") }),
        createdAt: new Date().toISOString(),
      };
      database.nextId += 1;
      database.tasks.push(task);
      await saveDatabase(database);
      return task;
    }

    case "list": {
      const flags = parseFlags(rest, ["--status", "--tag", "--overdue"]);
      const status = flags.get("--status");
      if (status !== undefined && status !== "open" && status !== "done") fail(`Invalid status: ${status}`);
      const tagValue = flags.get("--tag");
      const tag = tagValue?.trim().toLowerCase();
      if (tagValue !== undefined && tag === "") fail("Tag must not be empty");
      const overdueValue = flags.get("--overdue");
      const overdue = overdueValue === undefined ? undefined : parseDate(overdueValue, "--overdue");
      const database = await loadDatabase();
      return database.tasks
        .filter((task) => status === undefined || task.status === status)
        .filter((task) => tag === undefined || task.tags.includes(tag))
        .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
        .sort((left, right) => left.id - right.id);
    }

    case "done": {
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

    case "delete": {
      if (rest.length !== 1 || rest[0].startsWith("--")) fail("Usage: delete ID");
      const database = await loadDatabase();
      const task = findTask(database, parseId(rest[0]));
      database.tasks = database.tasks.filter((candidate) => candidate.id !== task.id);
      await saveDatabase(database);
      return task;
    }

    case "stats": {
      requireNoFlagsOrExtras(rest, "stats");
      const database = await loadDatabase();
      const today = localToday();
      const open = database.tasks.filter((task) => task.status === "open");
      return {
        total: database.tasks.length,
        open: open.length,
        done: database.tasks.length - open.length,
        overdue: open.filter((task) => task.due !== undefined && task.due < today).length,
      };
    }

    default:
      fail(`Unknown command: ${command}`);
  }
}

try {
  const result = await run(Bun.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.stderr.write(`taskboard: ${message}\n`);
  process.exitCode = 1;
}
