import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

class CliError extends Error {}

const databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function requireDate(value: string, option: string): string {
  if (!isDate(value)) fail(`${option} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function validateDatabase(value: unknown): Database {
  if (typeof value !== "object" || value === null) fail("database must contain a JSON object");
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.nextId) || (candidate.nextId as number) < 1 || !Array.isArray(candidate.tasks)) {
    fail("database has an invalid structure");
  }

  const ids = new Set<number>();
  for (const raw of candidate.tasks) {
    if (typeof raw !== "object" || raw === null) fail("database contains an invalid task");
    const task = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(task.id) || (task.id as number) < 1 || ids.has(task.id as number)) fail("database contains an invalid task id");
    ids.add(task.id as number);
    if (typeof task.title !== "string" || task.title.trim() === "") fail("database contains an invalid task title");
    if (task.status !== "open" && task.status !== "done") fail("database contains an invalid task status");
    if (!Array.isArray(task.tags) || task.tags.some((tag) => typeof tag !== "string" || tag === "")) fail("database contains invalid task tags");
    if (task.due !== undefined && !isDate(task.due)) fail("database contains an invalid due date");
    if (!isIsoTimestamp(task.createdAt)) fail("database contains an invalid creation timestamp");
    if (task.completedAt !== undefined && !isIsoTimestamp(task.completedAt)) fail("database contains an invalid completion timestamp");
    if (task.status === "done" && task.completedAt === undefined) fail("database contains a done task without a completion timestamp");
    if (task.status === "open" && task.completedAt !== undefined) fail("database contains an open task with a completion timestamp");
  }
  const maxId = candidate.tasks.reduce((max, task) => Math.max(max, (task as Task).id), 0);
  if ((candidate.nextId as number) <= maxId) fail("database nextId is invalid");
  return candidate as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await readFile(databasePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }
  try {
    return validateDatabase(JSON.parse(text));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("database contains malformed JSON");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const parent = dirname(databasePath);
  await mkdir(parent, { recursive: true });
  const temporaryPath = `${databasePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseOptions(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--")) fail(`unexpected argument: ${flag ?? ""}`);
    if (!allowed.has(flag)) fail(`unknown flag: ${flag}`);
    if (options.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    options.set(flag, value);
  }
  return options;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseId(args: string[], command: string): number {
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0])) fail(`${command} requires one positive integer ID`);
  const id = Number(args[0]);
  if (!Number.isSafeInteger(id)) fail("ID is too large");
  return id;
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function execute(argv: string[]): Promise<unknown> {
  const [command, ...args] = argv;
  if (!command) fail("missing command");

  if (command === "add") {
    const options = parseOptions(args, new Set(["--title", "--tags", "--due"]));
    const title = options.get("--title");
    if (title === undefined) fail("add requires --title");
    if (title.trim() === "") fail("title must not be empty");
    const tags = [...new Set((options.get("--tags") ?? "").split(",").map(normalizeTag).filter(Boolean))];
    const dueValue = options.get("--due");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title: title.trim(),
      status: "open",
      tags,
      ...(dueValue === undefined ? {} : { due: requireDate(dueValue, "--due") }),
      createdAt: new Date().toISOString(),
    };
    database.tasks.push(task);
    database.nextId += 1;
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(args, new Set(["--status", "--tag", "--overdue"]));
    const status = options.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
    const tagValue = options.get("--tag");
    const tag = tagValue === undefined ? undefined : normalizeTag(tagValue);
    if (tagValue !== undefined && !tag) fail("--tag must not be empty");
    const overdueValue = options.get("--overdue");
    const overdue = overdueValue === undefined ? undefined : requireDate(overdueValue, "--overdue");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    const id = parseId(args, "done");
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
    const id = parseId(args, "delete");
    const database = await loadDatabase();
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index === -1) fail(`task ${id} not found`);
    const [deleted] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return deleted;
  }

  if (command === "stats") {
    if (args.length !== 0) fail(`unexpected argument: ${args[0]}`);
    const database = await loadDatabase();
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open").length;
    return {
      total: database.tasks.length,
      open,
      done: database.tasks.length - open,
      overdue: database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`unknown command: ${command}`);
}

try {
  const result = await execute(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.stderr.write(`taskboard: ${message}\n`);
  process.exitCode = 1;
}
