import { rename, unlink, writeFile, readFile } from "node:fs/promises";
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

const databaseFile = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function assertDate(value: string, flag: string): string {
  if (!validDate(value)) fail(`${flag} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function normalizeTags(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.tags.some((tag) => tag === "" || tag !== tag.trim().toLowerCase())) return false;
  if (value.due !== undefined && (typeof value.due !== "string" || !validDate(value.due))) return false;
  if (value.completedAt !== undefined && (typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt)))) return false;
  if (value.status === "done" && typeof value.completedAt !== "string") return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  return true;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value)) fail("database is malformed");
  if (Object.keys(value).some((key) => !["version", "nextId", "tasks"].includes(key))) fail("database is malformed");
  if (value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("database is malformed");
  }
  if (!value.tasks.every(validateTask)) fail("database is malformed");
  const tasks = value.tasks as Task[];
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (value.nextId as number))) fail("database is malformed");
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await readFile(databaseFile, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  try {
    return validateDatabase(JSON.parse(text));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("database is malformed");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databaseFile);
  const temporary = join(directory, `.${basename(databaseFile)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, databaseFile);
  } catch (error) {
    try { await unlink(temporary); } catch {}
    throw error;
  }
}

function parseFlags(args: string[], definitions: Record<string, boolean>): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag.startsWith("--") || !(flag in definitions)) fail(`unknown flag: ${flag}`);
    if (flag in result) fail(`duplicate flag: ${flag}`);
    if (definitions[flag]) {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
      result[flag] = value;
    } else {
      result[flag] = true;
    }
  }
  return result;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
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
    const flags = parseFlags(rest, { "--title": true, "--tags": true, "--due": true });
    const titleValue = flags["--title"];
    if (typeof titleValue !== "string") fail("missing required flag: --title");
    const title = titleValue.trim();
    if (!title) fail("title must not be empty");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId++,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: typeof flags["--tags"] === "string" ? normalizeTags(flags["--tags"]) : [],
    };
    if (typeof flags["--due"] === "string") task.due = assertDate(flags["--due"], "--due");
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, { "--status": true, "--tag": true, "--overdue": true });
    const status = flags["--status"];
    if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
    const tag = typeof flags["--tag"] === "string" ? flags["--tag"].trim().toLowerCase() : undefined;
    if (tag === "") fail("--tag must not be empty");
    const overdue = typeof flags["--overdue"] === "string" ? assertDate(flags["--overdue"], "--overdue") : undefined;
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail(rest.length > 1 ? `unknown argument: ${rest[1]}` : "missing ID");
    const id = parseId(rest[0]);
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
    if (rest.length !== 1) fail(rest.length > 1 ? `unknown argument: ${rest[1]}` : "missing ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index < 0) fail(`task ${id} not found`);
    const [deleted] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return deleted;
  }

  if (command === "stats") {
    if (rest.length) fail(`unknown argument: ${rest[0]}`);
    const database = await loadDatabase();
    const today = localToday();
    return {
      total: database.tasks.length,
      open: database.tasks.filter((task) => task.status === "open").length,
      done: database.tasks.filter((task) => task.status === "done").length,
      overdue: database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`unknown command: ${command}`);
}

try {
  const result = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`taskboard: ${message}\n`);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
}
