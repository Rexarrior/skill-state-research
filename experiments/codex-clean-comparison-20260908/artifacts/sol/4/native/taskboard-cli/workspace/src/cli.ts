import { rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function isNormalizedTags(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string" && tag.length > 0)) {
    return false;
  }
  return value.every((tag, index) => tag === normalizeTag(tag) && value.indexOf(tag) === index);
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim().length === 0) return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isNormalizedTags(value.tags) || !isIsoTimestamp(value.createdAt)) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (value.status === "done") return isIsoTimestamp(value.completedAt);
  return value.completedAt === undefined;
}

function validateDatabase(value: unknown): value is Database {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) return false;
  if (!Array.isArray(value.tasks) || !value.tasks.every(validateTask)) return false;
  const ids = value.tasks.map((task) => task.id);
  const maximumId = ids.reduce((maximum, id) => Math.max(maximum, id), 0);
  return new Set(ids).size === ids.length && (value.nextId as number) > maximumId;
}

async function readDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    if (isMissingFileError(error)) return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`malformed database: ${databasePath}`);
  }
  if (!validateDatabase(parsed)) fail(`malformed database: ${databasePath}`);
  return parsed;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function writeDatabase(database: Database): Promise<void> {
  const temporaryPath = join(
    dirname(databasePath),
    `.${databasePath.split(/[\\/]/).pop() ?? "taskboard"}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { createPath: false });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

interface ParsedOptions {
  positionals: string[];
  options: Map<string, string>;
}

function parseArguments(args: string[], allowed: ReadonlySet<string>): ParsedOptions {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (!allowed.has(argument)) fail(`unknown flag: ${argument}`);
    if (options.has(argument)) fail(`duplicate flag: ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${argument}`);
    options.set(argument, value);
    index += 1;
  }
  return { positionals, options };
}

function requireNoPositionals(positionals: string[]): void {
  if (positionals.length > 0) fail(`unexpected argument: ${positionals[0]}`);
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function parseTags(value: string | undefined): string[] {
  if (value === undefined) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of value.split(",")) {
    const tag = normalizeTag(rawTag);
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

async function add(args: string[]): Promise<Task> {
  const { positionals, options } = parseArguments(args, new Set(["--title", "--tags", "--due"]));
  requireNoPositionals(positionals);
  const rawTitle = options.get("--title");
  if (rawTitle === undefined) fail("missing required flag: --title");
  const title = rawTitle.trim();
  if (title.length === 0) fail("title must not be empty");
  const due = options.get("--due");
  if (due !== undefined && !isDate(due)) fail("due date must be a valid YYYY-MM-DD date");

  const database = await readDatabase();
  const task: Task = {
    id: database.nextId,
    title,
    status: "open",
    tags: parseTags(options.get("--tags")),
    ...(due === undefined ? {} : { due }),
    createdAt: new Date().toISOString(),
  };
  database.tasks.push(task);
  database.nextId += 1;
  await writeDatabase(database);
  return task;
}

async function list(args: string[]): Promise<Task[]> {
  const { positionals, options } = parseArguments(args, new Set(["--status", "--tag", "--overdue"]));
  requireNoPositionals(positionals);
  const status = options.get("--status");
  if (status !== undefined && status !== "open" && status !== "done") {
    fail("status must be open or done");
  }
  const rawTag = options.get("--tag");
  const tag = rawTag === undefined ? undefined : normalizeTag(rawTag);
  if (tag !== undefined && tag.length === 0) fail("tag must not be empty");
  const overdue = options.get("--overdue");
  if (overdue !== undefined && !isDate(overdue)) fail("overdue date must be a valid YYYY-MM-DD date");

  const database = await readDatabase();
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
  const { positionals } = parseArguments(args, new Set());
  if (positionals.length !== 1) fail("usage: done ID");
  const id = parseId(positionals[0]);
  const database = await readDatabase();
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) fail(`task not found: ${id}`);
  if (task.status === "open") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    await writeDatabase(database);
  }
  return task;
}

async function deleteTask(args: string[]): Promise<Task> {
  const { positionals } = parseArguments(args, new Set());
  if (positionals.length !== 1) fail("usage: delete ID");
  const id = parseId(positionals[0]);
  const database = await readDatabase();
  const index = database.tasks.findIndex((task) => task.id === id);
  if (index < 0) fail(`task not found: ${id}`);
  const [task] = database.tasks.splice(index, 1);
  await writeDatabase(database);
  return task;
}

function localDate(date = new Date()): string {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function stats(args: string[]): Promise<{ total: number; open: number; done: number; overdue: number }> {
  const { positionals } = parseArguments(args, new Set());
  requireNoPositionals(positionals);
  const tasks = (await readDatabase()).tasks;
  const today = localDate();
  const open = tasks.filter((task) => task.status === "open").length;
  return {
    total: tasks.length,
    open,
    done: tasks.length - open,
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
    case undefined:
      fail("missing command");
    default:
      fail(`unknown command: ${command}`);
  }
}

try {
  const result = await run(Bun.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
}
