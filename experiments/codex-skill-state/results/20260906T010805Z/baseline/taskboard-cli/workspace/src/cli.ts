import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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

const databasePath = process.env.TASKBOARD_FILE ?? join(process.cwd(), ".taskboard.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;

  const monthLengths = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= monthLengths[month - 1];
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
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

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string" && tag !== "" && tag === normalizeTag(tag))) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && (typeof value.due !== "string" || !isValidDate(value.due))) return false;

  if (value.status === "done") {
    if (!isIsoTimestamp(value.completedAt)) return false;
  } else if (value.completedAt !== undefined) {
    return false;
  }

  return true;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    throw new CliError("malformed taskboard database");
  }
  if (!value.tasks.every(validateTask)) throw new CliError("malformed taskboard database");

  const ids = new Set<number>();
  let maximumId = 0;
  for (const task of value.tasks) {
    if (ids.has(task.id)) throw new CliError("malformed taskboard database");
    ids.add(task.id);
    maximumId = Math.max(maximumId, task.id);
  }
  if ((value.nextId as number) <= maximumId) throw new CliError("malformed taskboard database");

  return value as unknown as Database;
}

async function readDatabase(): Promise<Database> {
  let contents: string;
  try {
    contents = await Bun.file(databasePath).text();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }

  try {
    return validateDatabase(JSON.parse(contents));
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("malformed taskboard database");
  }
}

async function writeDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = join(directory, `.${basename(databasePath)}.${process.pid}.${randomUUID()}.tmp`);
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

function parseFlags(arguments_: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    if (!flag.startsWith("--") || !allowed.has(flag)) throw new CliError(`unknown flag: ${flag}`);
    if (flags.has(flag)) throw new CliError(`duplicate flag: ${flag}`);
    if (index + 1 >= arguments_.length || arguments_[index + 1].startsWith("--")) {
      throw new CliError(`missing value for ${flag}`);
    }
    flags.set(flag, arguments_[index + 1]);
  }
  return flags;
}

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new CliError(`missing required flag: ${name}`);
  return value;
}

function parseDate(value: string, flag: string): string {
  if (!isValidDate(value)) throw new CliError(`invalid date for ${flag}: ${value}`);
  return value;
}

function parseId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new CliError(`invalid task id: ${value}`);
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new CliError(`invalid task id: ${value}`);
  return id;
}

function localDate(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function add(arguments_: string[]): Promise<Task> {
  const flags = parseFlags(arguments_, new Set(["--title", "--tags", "--due"]));
  const title = requiredFlag(flags, "--title").trim();
  if (title === "") throw new CliError("title must not be empty");

  const dueValue = flags.get("--due");
  const due = dueValue === undefined ? undefined : parseDate(dueValue, "--due");
  const database = await readDatabase();
  if (!Number.isSafeInteger(database.nextId + 1)) throw new CliError("task id limit reached");

  const task: Task = {
    id: database.nextId,
    title,
    status: "open",
    createdAt: new Date().toISOString(),
    tags: flags.has("--tags") ? normalizeTags(flags.get("--tags")!) : [],
    ...(due === undefined ? {} : { due }),
  };
  database.nextId += 1;
  database.tasks.push(task);
  await writeDatabase(database);
  return task;
}

async function list(arguments_: string[]): Promise<Task[]> {
  const flags = parseFlags(arguments_, new Set(["--status", "--tag", "--overdue"]));
  const status = flags.get("--status");
  if (status !== undefined && status !== "open" && status !== "done") {
    throw new CliError(`invalid status: ${status}`);
  }
  const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
  if (tag === "") throw new CliError("tag must not be empty");
  const overdueValue = flags.get("--overdue");
  const overdue = overdueValue === undefined ? undefined : parseDate(overdueValue, "--overdue");

  const database = await readDatabase();
  return database.tasks
    .filter((task) => status === undefined || task.status === status)
    .filter((task) => tag === undefined || task.tags.includes(tag))
    .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
    .sort((left, right) => left.id - right.id);
}

async function done(arguments_: string[]): Promise<Task> {
  if (arguments_.length !== 1) throw new CliError("usage: done ID");
  const id = parseId(arguments_[0]);
  const database = await readDatabase();
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new CliError(`task not found: ${id}`);

  if (task.status === "open") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    await writeDatabase(database);
  }
  return task;
}

async function deleteTask(arguments_: string[]): Promise<Task> {
  if (arguments_.length !== 1) throw new CliError("usage: delete ID");
  const id = parseId(arguments_[0]);
  const database = await readDatabase();
  const index = database.tasks.findIndex((task) => task.id === id);
  if (index === -1) throw new CliError(`task not found: ${id}`);

  const [task] = database.tasks.splice(index, 1);
  await writeDatabase(database);
  return task;
}

async function stats(arguments_: string[]): Promise<{ total: number; open: number; done: number; overdue: number }> {
  if (arguments_.length !== 0) throw new CliError(`unknown flag: ${arguments_[0]}`);
  const database = await readDatabase();
  const today = localDate();
  const open = database.tasks.filter((task) => task.status === "open").length;
  return {
    total: database.tasks.length,
    open,
    done: database.tasks.length - open,
    overdue: database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
  };
}

async function main(arguments_: string[]): Promise<unknown> {
  const [command, ...commandArguments] = arguments_;
  switch (command) {
    case "add":
      return add(commandArguments);
    case "list":
      return list(commandArguments);
    case "done":
      return done(commandArguments);
    case "delete":
      return deleteTask(commandArguments);
    case "stats":
      return stats(commandArguments);
    default:
      throw new CliError(command === undefined ? "missing command" : `unknown command: ${command}`);
  }
}

try {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
}
