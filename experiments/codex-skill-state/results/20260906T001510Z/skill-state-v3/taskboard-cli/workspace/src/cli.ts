import { open, readFile, rename, unlink } from "node:fs/promises";
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

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function validateDatabase(value: unknown): Database {
  if (!isPlainObject(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    return fail("Malformed taskboard database");
  }

  const ids = new Set<number>();
  let greatestId = 0;
  for (const entry of value.tasks) {
    if (!isPlainObject(entry)) return fail("Malformed taskboard database");
    const id = entry.id;
    const tags = entry.tags;
    if (
      !Number.isSafeInteger(id) || (id as number) < 1 || ids.has(id as number) ||
      typeof entry.title !== "string" || entry.title.trim() === "" ||
      (entry.status !== "open" && entry.status !== "done") ||
      !Array.isArray(tags) || !tags.every((tag) => typeof tag === "string" && tag !== "" && tag === normalizeTag(tag)) ||
      new Set(tags).size !== tags.length || !isIsoTimestamp(entry.createdAt) ||
      (entry.due !== undefined && !isValidDate(entry.due)) ||
      (entry.completedAt !== undefined && !isIsoTimestamp(entry.completedAt)) ||
      (entry.status === "open" && entry.completedAt !== undefined) ||
      (entry.status === "done" && !isIsoTimestamp(entry.completedAt))
    ) {
      return fail("Malformed taskboard database");
    }
    ids.add(id as number);
    greatestId = Math.max(greatestId, id as number);
  }

  if ((value.nextId as number) <= greatestId) return fail("Malformed taskboard database");
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await readFile(databasePath, "utf8");
  } catch (error) {
    if (isPlainObject(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }

  try {
    return validateDatabase(JSON.parse(text));
  } catch (error) {
    if (error instanceof CliError) throw error;
    return fail("Malformed taskboard database");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = join(directory, `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(database, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, databasePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) fail(`Unknown flag: ${flag ?? ""}`);
    if (flags.has(flag)) fail(`Duplicate flag: ${flag}`);
    const value = args[index + 1];
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
    if (title === undefined) fail("Missing required flag: --title");
    if (title === "") fail("Title must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isValidDate(due)) fail("Due date must be a valid YYYY-MM-DD date");
    const tags = [...new Set((flags.get("--tags") ?? "").split(",").map(normalizeTag).filter(Boolean))];
    const database = await loadDatabase();
    const task: Task = { id: database.nextId, title, status: "open", tags, createdAt: new Date().toISOString() };
    if (due !== undefined) task.due = due;
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("Status must be open or done");
    const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
    if (tag === "") fail("Tag must not be empty");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isValidDate(overdue)) fail("Overdue date must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("Usage: done ID");
    const id = parseId(rest[0]);
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

  if (command === "delete") {
    if (rest.length !== 1) fail("Usage: delete ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index === -1) fail(`Task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`Unknown flag: ${rest[0]}`);
    const tasks = (await loadDatabase()).tasks;
    const today = localToday();
    return {
      total: tasks.length,
      open: tasks.filter((task) => task.status === "open").length,
      done: tasks.filter((task) => task.status === "done").length,
      overdue: tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`Unknown command: ${command}`);
}

try {
  const result = await execute(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
