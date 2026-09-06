import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
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
  nextId: number;
  tasks: Task[];
}

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

class CliError extends Error {}

function fail(message: string): never {
  throw new CliError(message);
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

function parseId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    fail("ID must be a positive integer");
  }
  return Number(value);
}

function parseFlags(args: string[], allowed: Set<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag)) fail(`unknown flag: ${flag}`);
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    if (result.has(flag)) fail(`duplicate flag: ${flag}`);
    result.set(flag, value);
  }
  return result;
}

function validateTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  const keys = Object.keys(task);
  const allowed = new Set(["id", "title", "status", "tags", "due", "createdAt", "completedAt"]);
  return keys.every((key) => allowed.has(key)) &&
    Number.isSafeInteger(task.id) && Number(task.id) > 0 &&
    typeof task.title === "string" && task.title.length > 0 &&
    (task.status === "open" || task.status === "done") &&
    Array.isArray(task.tags) && task.tags.every((tag) => typeof tag === "string") &&
    (task.due === undefined || (typeof task.due === "string" && isDate(task.due))) &&
    typeof task.createdAt === "string" && !Number.isNaN(Date.parse(task.createdAt)) &&
    (task.completedAt === undefined || (typeof task.completedAt === "string" && !Number.isNaN(Date.parse(task.completedAt))));
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await readFile(databasePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("database contains malformed JSON");
  }
  if (!value || typeof value !== "object") fail("database has an invalid schema");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "nextId" && key !== "tasks") ||
      !Number.isSafeInteger(record.nextId) || Number(record.nextId) < 1 ||
      !Array.isArray(record.tasks) || !record.tasks.every(validateTask)) {
    fail("database has an invalid schema");
  }
  const tasks = record.tasks as Task[];
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length || tasks.some((task) => task.id >= Number(record.nextId))) {
    fail("database has an invalid schema");
  }
  return { nextId: Number(record.nextId), tasks };
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(database, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, databasePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function withMutation<T>(operation: (database: Database) => Promise<T> | T): Promise<T> {
  const lockPath = `${databasePath}.lock`;
  await mkdir(dirname(databasePath), { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("database is locked by another process");
    throw error;
  }
  try {
    const database = await loadDatabase();
    const result = await operation(database);
    await saveDatabase(database);
    return result;
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function localDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title")?.trim();
    if (!title) fail("--title is required and cannot be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isDate(due)) fail("--due must be a valid YYYY-MM-DD date");
    const tags = [...new Set((flags.get("--tags") || "").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
    return withMutation((database) => {
      const task: Task = { id: database.nextId++, title, status: "open", tags, createdAt: new Date().toISOString() };
      if (due !== undefined) task.due = due;
      database.tasks.push(task);
      return task;
    });
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail("--overdue must be a valid YYYY-MM-DD date");
    const tag = flags.get("--tag")?.trim().toLowerCase();
    if (flags.has("--tag") && !tag) fail("--tag cannot be empty");
    const database = await loadDatabase();
    return database.tasks.filter((task) =>
      (status === undefined || task.status === status) &&
      (tag === undefined || task.tags.includes(tag)) &&
      (overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
    ).sort((a, b) => a.id - b.id);
  }

  if (command === "done" || command === "delete") {
    if (rest.length !== 1) fail(`usage: ${command} ID`);
    const id = parseId(rest[0]);
    return withMutation((database) => {
      const index = database.tasks.findIndex((task) => task.id === id);
      if (index < 0) fail(`task ${id} not found`);
      const task = database.tasks[index];
      if (command === "delete") {
        database.tasks.splice(index, 1);
        return task;
      }
      if (task.status === "open") {
        task.status = "done";
        task.completedAt = new Date().toISOString();
      }
      return task;
    });
  }

  if (command === "stats") {
    if (rest.length) fail("stats does not accept arguments");
    const database = await loadDatabase();
    const today = localDate();
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
  console.log(JSON.stringify(await run(Bun.argv.slice(2))));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
