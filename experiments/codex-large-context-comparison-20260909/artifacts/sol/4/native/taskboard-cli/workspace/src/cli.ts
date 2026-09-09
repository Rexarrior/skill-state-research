import { open, readFile, rename, unlink } from "node:fs/promises";
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
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function requireDate(value: string, option: string): string {
  if (!isDate(value)) fail(`${option} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const tag = normalizeTag(raw);
    if (tag !== "" && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string" && tag !== "")) return false;
  if (new Set(value.tags).size !== value.tags.length || value.tags.some((tag) => normalizeTag(tag) !== tag)) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && value.completedAt === undefined) return false;
  return true;
}

function parseDatabase(value: unknown): Database {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "nextId" && key !== "tasks")) {
    fail("malformed task database");
  }
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("malformed task database");
  }
  if (!value.tasks.every(isTask)) fail("malformed task database");

  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (value.nextId as number))) {
    fail("malformed task database");
  }
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

  try {
    return parseDatabase(JSON.parse(contents));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("malformed task database");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = join(
    directory,
    `.${basename(databasePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(`${JSON.stringify(database, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, databasePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseOptions(
  args: string[],
  allowed: ReadonlySet<string>,
): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) fail(`unknown flag: ${flag ?? ""}`);
    if (options.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined) fail(`missing value for ${flag}`);
    options.set(flag, value);
  }
  return options;
}

function requireId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function findTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`task ${id} not found`);
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
  const [command, ...rest] = args;

  if (command === "add") {
    const options = parseOptions(rest, new Set(["--title", "--tags", "--due"]));
    const titleValue = options.get("--title");
    if (titleValue === undefined) fail("missing required flag: --title");
    const title = titleValue.trim();
    if (title === "") fail("title must not be empty");
    const dueValue = options.get("--due");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: normalizeTags(options.get("--tags") ?? ""),
      ...(dueValue === undefined ? {} : { due: requireDate(dueValue, "--due") }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = options.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("--status must be open or done");
    }
    const tagValue = options.get("--tag");
    const tag = tagValue === undefined ? undefined : normalizeTag(tagValue);
    if (tag === "") fail("--tag must not be empty");
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
    if (rest.length !== 1) fail("usage: done ID");
    const id = requireId(rest[0]);
    const database = await loadDatabase();
    const task = findTask(database, id);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("usage: delete ID");
    const id = requireId(rest[0]);
    const database = await loadDatabase();
    const task = findTask(database, id);
    database.tasks = database.tasks.filter((candidate) => candidate.id !== id);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`unknown flag: ${rest[0]}`);
    const database = await loadDatabase();
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length;
    return { total: database.tasks.length, open, done, overdue };
  }

  fail(command === undefined ? "missing command" : `unknown command: ${command}`);
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
