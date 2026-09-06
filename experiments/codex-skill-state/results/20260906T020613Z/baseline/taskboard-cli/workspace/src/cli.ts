import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type TaskStatus = "open" | "done";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
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

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function fail(message: string): never {
  throw new CliError(message);
}

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

  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
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
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== normalizeTag(tag))) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && (typeof value.due !== "string" || !isValidDate(value.due))) return false;
  if (value.status === "done") {
    if (typeof value.completedAt !== "string" || Number.isNaN(Date.parse(value.completedAt))) return false;
  } else if (value.completedAt !== undefined) {
    return false;
  }
  return true;
}

function validateDatabase(value: unknown): value is Database {
  if (!isRecord(value) || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    return false;
  }
  if (!value.tasks.every(validateTask)) return false;

  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) return false;
  const maxId = ids.length === 0 ? 0 : Math.max(...ids);
  return (value.nextId as number) > maxId;
}

async function loadDatabase(path: string): Promise<Database> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`Malformed database: ${path}`);
  }
  if (!validateDatabase(value)) fail(`Malformed database: ${path}`);
  return value;
}

async function saveDatabase(path: string, database: Database): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(database, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

interface ParsedOptions {
  options: Map<string, string>;
  positionals: string[];
}

function parseArguments(args: string[], allowedOptions: ReadonlySet<string>): ParsedOptions {
  const options = new Map<string, string>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const equalsIndex = argument.indexOf("=");
    const name = equalsIndex === -1 ? argument.slice(2) : argument.slice(2, equalsIndex);
    if (name === "" || !allowedOptions.has(name)) fail(`Unknown flag: --${name}`);
    if (options.has(name)) fail(`Duplicate flag: --${name}`);

    const value = equalsIndex === -1 ? args[++index] : argument.slice(equalsIndex + 1);
    if (value === undefined || (equalsIndex === -1 && value.startsWith("--"))) fail(`Missing value for --${name}`);
    options.set(name, value);
  }
  return { options, positionals };
}

function requireNoPositionals(positionals: string[]): void {
  if (positionals.length > 0) fail(`Unexpected argument: ${positionals[0]}`);
}

function parseId(value: string | undefined, extras: string[]): number {
  if (value === undefined) fail("Missing task ID");
  if (extras.length > 0) fail(`Unexpected argument: ${extras[0]}`);
  if (!/^[1-9]\d*$/.test(value)) fail(`Invalid task ID: ${value}`);
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail(`Invalid task ID: ${value}`);
  return id;
}

function findTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`Task not found: ${id}`);
  return task;
}

function localDate(date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function run(args: string[], databasePath = process.env.TASKBOARD_FILE || resolve(process.cwd(), ".taskboard.json")): Promise<JsonValue> {
  const [command, ...commandArgs] = args;
  if (!command) fail("Missing command");

  if (command === "add") {
    const { options, positionals } = parseArguments(commandArgs, new Set(["title", "tags", "due"]));
    requireNoPositionals(positionals);
    const title = options.get("title");
    if (title === undefined || title.trim() === "") fail("--title is required and must not be empty");
    const due = options.get("due");
    if (due !== undefined && !isValidDate(due)) fail(`Invalid due date: ${due}`);

    const database = await loadDatabase(databasePath);
    if (database.nextId === Number.MAX_SAFE_INTEGER) fail("Cannot allocate another task ID");
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: normalizeTags(options.get("tags") ?? ""),
      ...(due === undefined ? {} : { due }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(databasePath, database);
    return task as unknown as JsonValue;
  }

  if (command === "list") {
    const { options, positionals } = parseArguments(commandArgs, new Set(["status", "tag", "overdue"]));
    requireNoPositionals(positionals);
    const status = options.get("status");
    if (status !== undefined && status !== "open" && status !== "done") fail(`Invalid status: ${status}`);
    const overdue = options.get("overdue");
    if (overdue !== undefined && !isValidDate(overdue)) fail(`Invalid overdue date: ${overdue}`);
    const tag = options.has("tag") ? normalizeTag(options.get("tag")!) : undefined;
    if (tag === "") fail("--tag must not be empty");

    const database = await loadDatabase(databasePath);
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id) as unknown as JsonValue;
  }

  if (command === "done") {
    const { options, positionals } = parseArguments(commandArgs, new Set());
    void options;
    const id = parseId(positionals[0], positionals.slice(1));
    const database = await loadDatabase(databasePath);
    const task = findTask(database, id);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(databasePath, database);
    }
    return task as unknown as JsonValue;
  }

  if (command === "delete") {
    const { options, positionals } = parseArguments(commandArgs, new Set());
    void options;
    const id = parseId(positionals[0], positionals.slice(1));
    const database = await loadDatabase(databasePath);
    const task = findTask(database, id);
    database.tasks = database.tasks.filter((candidate) => candidate.id !== id);
    await saveDatabase(databasePath, database);
    return task as unknown as JsonValue;
  }

  if (command === "stats") {
    const { options, positionals } = parseArguments(commandArgs, new Set());
    void options;
    requireNoPositionals(positionals);
    const database = await loadDatabase(databasePath);
    const today = localDate();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length;
    return { total: database.tasks.length, open, done, overdue };
  }

  fail(`Unknown command: ${command}`);
}

if (import.meta.main) {
  try {
    const result = await run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
