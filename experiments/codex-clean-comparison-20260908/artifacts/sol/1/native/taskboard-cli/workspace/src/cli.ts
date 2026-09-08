import { rename, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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

const databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function parseDate(value: string, option: string): string {
  if (!isDate(value)) fail(`${option} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of value.split(",")) {
    const tag = normalizeTag(rawTag);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("database has an invalid structure");
  }

  const ids = new Set<number>();
  let maximumId = 0;
  for (const rawTask of value.tasks) {
    if (!isRecord(rawTask)) fail("database contains an invalid task");
    const { id, title, status, createdAt, tags, due, completedAt } = rawTask;
    if (
      !Number.isSafeInteger(id) ||
      (id as number) < 1 ||
      ids.has(id as number) ||
      typeof title !== "string" ||
      title.trim().length === 0 ||
      (status !== "open" && status !== "done") ||
      !isIsoTimestamp(createdAt) ||
      !Array.isArray(tags) ||
      !tags.every((tag) => typeof tag === "string" && tag.length > 0 && normalizeTag(tag) === tag) ||
      new Set(tags).size !== tags.length ||
      (due !== undefined && !isDate(due)) ||
      (completedAt !== undefined && !isIsoTimestamp(completedAt)) ||
      (status === "done" && completedAt === undefined) ||
      (status === "open" && completedAt !== undefined)
    ) {
      fail("database contains an invalid task");
    }
    ids.add(id as number);
    maximumId = Math.max(maximumId, id as number);
  }
  if ((value.nextId as number) <= maximumId) fail("database nextId is invalid");
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let contents: string;
  try {
    contents = await readFile(databasePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail("database is not valid JSON");
  }
  return validateDatabase(parsed);
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
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag.startsWith("--")) fail(`unexpected argument: ${flag}`);
    if (!allowed.has(flag)) fail(`unknown flag: ${flag}`);
    if (flags.has(flag)) fail(`duplicate flag: ${flag}`);
    if (index + 1 >= args.length) fail(`missing value for ${flag}`);
    flags.set(flag, args[index + 1]);
  }
  return flags;
}

function parseId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function requireTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`task ${id} does not exist`);
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
  const command = args[0];
  if (!command) fail("missing command");

  if (command === "add") {
    const flags = parseFlags(args.slice(1), new Set(["--title", "--tags", "--due"]));
    if (!flags.has("--title")) fail("missing required flag: --title");
    const title = flags.get("--title")!.trim();
    if (!title) fail("title must not be empty");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: flags.has("--tags") ? normalizeTags(flags.get("--tags")!) : [],
    };
    if (flags.has("--due")) task.due = parseDate(flags.get("--due")!, "--due");
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(args.slice(1), new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("--status must be open or done");
    }
    const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
    if (tag !== undefined && !tag) fail("--tag must not be empty");
    const overdue = flags.has("--overdue") ? parseDate(flags.get("--overdue")!, "--overdue") : undefined;
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (args.length !== 2) fail("usage: done ID");
    const database = await loadDatabase();
    const task = requireTask(database, parseId(args[1]));
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (args.length !== 2) fail("usage: delete ID");
    const database = await loadDatabase();
    const id = parseId(args[1]);
    const task = requireTask(database, id);
    database.tasks = database.tasks.filter((candidate) => candidate.id !== id);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (args.length !== 1) fail("usage: stats");
    const database = await loadDatabase();
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length;
    return { total: database.tasks.length, open, done, overdue };
  }

  fail(`unknown command: ${command}`);
}

if (import.meta.main) {
  try {
    const result = await run(process.argv.slice(2));
    console.log(JSON.stringify(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`taskboard: ${message}`);
    console.log(JSON.stringify({ error: message }));
    process.exitCode = 1;
  }
}

export { run };
