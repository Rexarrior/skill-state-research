import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
  version: 1;
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INTEGER_PATTERN = /^[1-9]\d*$/;

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of value.split(",")) {
    const tag = normalizeTag(rawTag);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

function assertTask(value: unknown): asserts value is Task {
  if (!isRecord(value)) fail("Malformed database: task must be an object");
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) {
    fail("Malformed database: task id must be a positive integer");
  }
  if (typeof value.title !== "string" || value.title.trim() === "") {
    fail("Malformed database: task title must be non-empty");
  }
  if (value.status !== "open" && value.status !== "done") {
    fail("Malformed database: invalid task status");
  }
  if (!isIsoTimestamp(value.createdAt)) {
    fail("Malformed database: invalid createdAt timestamp");
  }
  if (!Array.isArray(value.tags)) {
    fail("Malformed database: task tags must be an array");
  }

  const tags = value.tags;
  const normalized = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== "string" || tag === "" || normalizeTag(tag) !== tag || normalized.has(tag)) {
      fail("Malformed database: task tags must be unique normalized strings");
    }
    normalized.add(tag);
  }

  if (value.due !== undefined && !isValidDate(value.due)) {
    fail("Malformed database: invalid due date");
  }
  if (value.status === "done" && !isIsoTimestamp(value.completedAt)) {
    fail("Malformed database: done task must have completedAt");
  }
  if (value.status === "open" && value.completedAt !== undefined) {
    fail("Malformed database: open task cannot have completedAt");
  }
}

function parseDatabase(text: string): Database {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("Malformed database: invalid JSON");
  }

  if (!isRecord(value) || value.version !== 1) {
    fail("Malformed database: unsupported or missing version");
  }
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) {
    fail("Malformed database: nextId must be a positive integer");
  }
  if (!Array.isArray(value.tasks)) {
    fail("Malformed database: tasks must be an array");
  }

  const ids = new Set<number>();
  let maximumId = 0;
  for (const task of value.tasks) {
    assertTask(task);
    if (ids.has(task.id)) fail("Malformed database: duplicate task id");
    ids.add(task.id);
    maximumId = Math.max(maximumId, task.id);
  }
  if ((value.nextId as number) <= maximumId) {
    fail("Malformed database: nextId must be greater than every task id");
  }

  return value as unknown as Database;
}

async function loadDatabase(path: string): Promise<Database> {
  try {
    return parseDatabase(await readFile(path, "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    throw error;
  }
}

async function saveDatabase(path: string, database: Database): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--")) fail(`Unexpected argument: ${flag ?? ""}`);
    if (!allowed.has(flag)) fail(`Unknown flag: ${flag}`);
    if (flags.has(flag)) fail(`Duplicate flag: ${flag}`);

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !INTEGER_PATTERN.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a safe positive integer");
  return id;
}

function findTask(database: Database, id: number): Task {
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`Task ${id} not found`);
  return task;
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[], databasePath: string): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("Missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const rawTitle = flags.get("--title");
    if (rawTitle === undefined) fail("Missing required flag: --title");
    const title = rawTitle.trim();
    if (!title) fail("Title must not be empty");

    const due = flags.get("--due");
    if (due !== undefined && !isValidDate(due)) fail("Due date must be a valid YYYY-MM-DD date");

    const database = await loadDatabase(databasePath);
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: normalizeTags(flags.get("--tags") ?? ""),
      ...(due === undefined ? {} : { due }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(databasePath, database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("Status must be open or done");
    }
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isValidDate(overdue)) {
      fail("Overdue date must be a valid YYYY-MM-DD date");
    }
    const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
    if (tag === "") fail("Tag must not be empty");

    const database = await loadDatabase(databasePath);
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

  if (command === "done") {
    if (rest.length !== 1) fail("Usage: done ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase(databasePath);
    const task = findTask(database, id);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(databasePath, database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("Usage: delete ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase(databasePath);
    const taskIndex = database.tasks.findIndex((task) => task.id === id);
    if (taskIndex === -1) fail(`Task ${id} not found`);
    database.tasks.splice(taskIndex, 1);
    await saveDatabase(databasePath, database);
    return { deleted: id };
  }

  if (command === "stats") {
    if (rest.length !== 0) fail("Usage: stats");
    const database = await loadDatabase(databasePath);
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length;
    return { total: database.tasks.length, open, done, overdue };
  }

  fail(`Unknown command: ${command}`);
}

const databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");

try {
  const output = await run(Bun.argv.slice(2), databasePath);
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.stderr.write(`taskboard: ${message}\n`);
  process.exitCode = 1;
}
