import { readFile, rename, unlink } from "node:fs/promises";
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
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseDate(value: string, label = "date"): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${label} must use YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(0);
  candidate.setUTCFullYear(year, month - 1, day);
  candidate.setUTCHours(0, 0, 0, 0);
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    fail(`${label} is not a valid calendar date`);
  }
  return value;
}

function normalizeTag(value: string): string {
  const tag = value.trim().toLowerCase();
  if (!tag) fail("tag must not be empty");
  return tag;
}

function normalizeTags(value: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const tag = part.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function validateTask(value: unknown): Task {
  if (!isRecord(value)) fail("database contains an invalid task");
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail("database contains an invalid task");
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) fail("database contains an invalid task id");
  if (typeof value.title !== "string" || !value.title.trim()) fail("database contains an invalid task title");
  if (value.status !== "open" && value.status !== "done") fail("database contains an invalid task status");
  if (!isIsoTimestamp(value.createdAt)) fail("database contains an invalid creation timestamp");
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || !tag)) {
    fail("database contains invalid tags");
  }
  if (new Set(value.tags).size !== value.tags.length || value.tags.some((tag) => tag !== tag.trim().toLowerCase())) {
    fail("database contains non-normalized tags");
  }
  if (value.due !== undefined) {
    if (typeof value.due !== "string") fail("database contains an invalid due date");
    parseDate(value.due, "stored due date");
  }
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) {
    fail("database contains an invalid completion timestamp");
  }
  if (value.status === "done" && value.completedAt === undefined) fail("done task lacks completedAt");
  if (value.status === "open" && value.completedAt !== undefined) fail("open task has completedAt");
  return value as unknown as Task;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value)) fail("database root must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => !["version", "nextId", "tasks"].includes(key))) fail("database has unknown fields");
  if (value.version !== 1) fail("unsupported database version");
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) fail("database has invalid nextId");
  if (!Array.isArray(value.tasks)) fail("database tasks must be an array");
  const tasks = value.tasks.map(validateTask);
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) fail("database contains duplicate task ids");
  const maxId = tasks.reduce((maximum, task) => Math.max(maximum, task.id), 0);
  if ((value.nextId as number) <= maxId) fail("database nextId is not greater than existing ids");
  return { version: 1, nextId: value.nextId as number, tasks };
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await readFile(databasePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("database is not valid JSON");
  }
  return validateDatabase(parsed);
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = join(directory, `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Nothing to clean up if creation failed or rename already succeeded.
    }
    throw error;
  }
}

function parseOptions(args: string[], definitions: Record<string, boolean>): Record<string, string | true> {
  const options: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag.startsWith("--") || !(flag in definitions)) fail(`unknown argument: ${flag}`);
    if (flag in options) fail(`duplicate flag: ${flag}`);
    if (!definitions[flag]) {
      options[flag] = true;
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    options[flag] = value;
  }
  return options;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID is too large");
  return id;
}

function requireTask(database: Database, id: number): Task {
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
  if (!command) fail("missing command");

  if (command === "add") {
    const options = parseOptions(rest, { "--title": true, "--tags": true, "--due": true });
    const rawTitle = options["--title"];
    if (typeof rawTitle !== "string") fail("missing required --title");
    const title = rawTitle.trim();
    if (!title) fail("title must not be empty");
    const due = options["--due"];
    if (due !== undefined && typeof due !== "string") fail("invalid --due");
    if (typeof due === "string") parseDate(due, "due date");
    const rawTags = options["--tags"];
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: typeof rawTags === "string" ? normalizeTags(rawTags) : [],
      ...(typeof due === "string" ? { due } : {}),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(rest, { "--status": true, "--tag": true, "--overdue": true });
    const status = options["--status"];
    if (status !== undefined && status !== "open" && status !== "done") fail("status must be open or done");
    const tag = options["--tag"];
    const normalizedTag = typeof tag === "string" ? normalizeTag(tag) : undefined;
    const overdue = options["--overdue"];
    if (overdue !== undefined && typeof overdue !== "string") fail("invalid --overdue");
    if (typeof overdue === "string") parseDate(overdue, "overdue date");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => normalizedTag === undefined || task.tags.includes(normalizedTag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("usage: done ID");
    const database = await loadDatabase();
    const task = requireTask(database, parseId(rest[0]));
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("usage: delete ID");
    const database = await loadDatabase();
    const task = requireTask(database, parseId(rest[0]));
    database.tasks = database.tasks.filter((candidate) => candidate.id !== task.id);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail("stats does not accept arguments");
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

try {
  const result = await run(Bun.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`taskboard: ${message}\n`);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
}
