import { rename, unlink, writeFile } from "node:fs/promises";
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

class CliError extends Error {}

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
  return [...new Set(value.split(",").map(normalizeTag).filter(Boolean))];
}

function validateDatabase(value: unknown): Database {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("Malformed taskboard database");
  }

  const ids = new Set<number>();
  let maximumId = 0;
  for (const item of value.tasks) {
    if (
      !isPlainObject(item) ||
      !Number.isSafeInteger(item.id) ||
      (item.id as number) < 1 ||
      typeof item.title !== "string" ||
      item.title.trim() === "" ||
      (item.status !== "open" && item.status !== "done") ||
      !Array.isArray(item.tags) ||
      !item.tags.every((tag) => typeof tag === "string" && tag !== "" && tag === normalizeTag(tag)) ||
      new Set(item.tags).size !== item.tags.length ||
      !isIsoTimestamp(item.createdAt) ||
      (item.due !== undefined && !isValidDate(item.due)) ||
      (item.completedAt !== undefined && !isIsoTimestamp(item.completedAt)) ||
      (item.status === "open" && item.completedAt !== undefined) ||
      (item.status === "done" && !isIsoTimestamp(item.completedAt))
    ) {
      fail("Malformed taskboard database");
    }

    const id = item.id as number;
    if (ids.has(id)) fail("Malformed taskboard database");
    ids.add(id);
    maximumId = Math.max(maximumId, id);
  }

  if ((value.nextId as number) <= maximumId) fail("Malformed taskboard database");
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let contents: string;
  try {
    contents = await Bun.file(databasePath).text();
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
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseFlags(args: string[], allowed: Set<string>): Map<string, string> {
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

function requireExactArgumentCount(args: string[], count: number, usage: string): void {
  if (args.length !== count) fail(`Usage: ${usage}`);
}

async function add(args: string[]): Promise<Task> {
  const flags = parseFlags(args, new Set(["--title", "--tags", "--due"]));
  const title = flags.get("--title");
  if (title === undefined) fail("Missing required flag: --title");
  if (title.trim() === "") fail("Title must not be empty");

  const due = flags.get("--due");
  if (due !== undefined && !isValidDate(due)) fail("Due date must be a valid YYYY-MM-DD date");

  const database = await loadDatabase();
  const task: Task = {
    id: database.nextId,
    title,
    status: "open",
    tags: normalizeTags(flags.get("--tags") ?? ""),
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
    fail("Status must be open or done");
  }
  const tagValue = flags.get("--tag");
  const tag = tagValue === undefined ? undefined : normalizeTag(tagValue);
  if (tagValue !== undefined && tag === "") fail("Tag must not be empty");
  const overdue = flags.get("--overdue");
  if (overdue !== undefined && !isValidDate(overdue)) {
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
  requireExactArgumentCount(args, 1, "done ID");
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
  requireExactArgumentCount(args, 1, "delete ID");
  const id = parseId(args[0]);
  const database = await loadDatabase();
  const index = database.tasks.findIndex((candidate) => candidate.id === id);
  if (index === -1) fail(`Task ${id} not found`);
  const [task] = database.tasks.splice(index, 1);
  await saveDatabase(database);
  return task;
}

function localDate(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function stats(args: string[]): Promise<{ total: number; open: number; done: number; overdue: number }> {
  requireExactArgumentCount(args, 0, "stats");
  const tasks = (await loadDatabase()).tasks;
  const today = localDate();
  return {
    total: tasks.length,
    open: tasks.filter((task) => task.status === "open").length,
    done: tasks.filter((task) => task.status === "done").length,
    overdue: tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length,
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
      return deleteTask(rest);
    case "stats":
      return stats(rest);
    default:
      fail(command === undefined ? "Missing command" : `Unknown command: ${command}`);
  }
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
