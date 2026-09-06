import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

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

const databasePath = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

function requireDate(value: string, option: string): string {
  if (!isCalendarDate(value)) {
    fail(`${option} must be a valid date in YYYY-MM-DD format`);
  }
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
  return [...new Set(value.split(",").map(normalizeTag).filter(Boolean))];
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags)) return false;
  if (!value.tags.every((tag) => typeof tag === "string" && tag !== "" && tag === normalizeTag(tag))) {
    return false;
  }
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && (typeof value.due !== "string" || !isCalendarDate(value.due))) {
    return false;
  }
  if (value.status === "done" && !isIsoTimestamp(value.completedAt)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  return true;
}

function validateDatabase(value: unknown): value is Database {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) return false;
  if (!Array.isArray(value.tasks) || !value.tasks.every(validateTask)) return false;

  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) return false;
  const largestId = ids.length === 0 ? 0 : Math.max(...ids);
  return (value.nextId as number) > largestId;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await readFile(databasePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    throw new CliError(`cannot read database: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliError("database contains malformed JSON");
  }
  if (!validateDatabase(value)) {
    throw new CliError("database has an invalid structure");
  }
  return value;
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = resolve(
    directory,
    `.${basename(databasePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(database, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, databasePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new CliError(`cannot write database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface ParsedOptions {
  values: Map<string, string>;
  positionals: string[];
}

function parseOptions(args: string[], allowed: Set<string>): ParsedOptions {
  const values = new Map<string, string>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (!allowed.has(argument)) fail(`unknown flag: ${argument}`);
    if (values.has(argument)) fail(`flag specified more than once: ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${argument}`);
    values.set(argument, value);
    index += 1;
  }

  return { values, positionals };
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function expectPositionals(positionals: string[], count: number, command: string): void {
  if (positionals.length !== count) fail(`invalid arguments for ${command}`);
}

function localDate(date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("missing command");

  if (command === "add") {
    const parsed = parseOptions(rest, new Set(["--title", "--tags", "--due"]));
    expectPositionals(parsed.positionals, 0, command);
    const rawTitle = parsed.values.get("--title");
    if (rawTitle === undefined) fail("missing required flag: --title");
    const title = rawTitle.trim();
    if (title === "") fail("title must not be empty");

    const database = await loadDatabase();
    if (database.nextId === Number.MAX_SAFE_INTEGER) fail("task ID space is exhausted");
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: normalizeTags(parsed.values.get("--tags") ?? ""),
    };
    const due = parsed.values.get("--due");
    if (due !== undefined) task.due = requireDate(due, "--due");
    database.tasks.push(task);
    database.nextId += 1;
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const parsed = parseOptions(rest, new Set(["--status", "--tag", "--overdue"]));
    expectPositionals(parsed.positionals, 0, command);
    const status = parsed.values.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("--status must be open or done");
    }
    const rawTag = parsed.values.get("--tag");
    const tag = rawTag === undefined ? undefined : normalizeTag(rawTag);
    if (tag === "") fail("--tag must not be empty");
    const rawOverdue = parsed.values.get("--overdue");
    const overdue = rawOverdue === undefined ? undefined : requireDate(rawOverdue, "--overdue");

    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter(
        (task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue),
      )
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    const parsed = parseOptions(rest, new Set());
    expectPositionals(parsed.positionals, 1, command);
    const id = parseId(parsed.positionals[0]);
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`task ${id} does not exist`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    const parsed = parseOptions(rest, new Set());
    expectPositionals(parsed.positionals, 1, command);
    const id = parseId(parsed.positionals[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`task ${id} does not exist`);
    database.tasks.splice(index, 1);
    await saveDatabase(database);
    return { deleted: id };
  }

  if (command === "stats") {
    const parsed = parseOptions(rest, new Set());
    expectPositionals(parsed.positionals, 0, command);
    const database = await loadDatabase();
    const today = localDate();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length;
    return { total: database.tasks.length, open, done, overdue };
  }

  fail(`unknown command: ${command}`);
}

try {
  const result = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.stderr.write(`taskboard: ${message}\n`);
  process.exitCode = 1;
}
