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
  version: 1;
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

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("Malformed taskboard database");
  }

  const ids = new Set<number>();
  let maxId = 0;
  for (const item of value.tasks) {
    if (!isRecord(item) || !Number.isSafeInteger(item.id) || (item.id as number) < 1 || typeof item.title !== "string" || item.title.trim() === "" || (item.status !== "open" && item.status !== "done") || !Array.isArray(item.tags) || !isIsoTimestamp(item.createdAt)) {
      fail("Malformed taskboard database");
    }
    if (ids.has(item.id as number)) fail("Malformed taskboard database");
    ids.add(item.id as number);
    maxId = Math.max(maxId, item.id as number);

    const tags = item.tags as unknown[];
    if (tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== normalizeTag(tag)) || new Set(tags).size !== tags.length) {
      fail("Malformed taskboard database");
    }
    if (item.due !== undefined && !validDate(item.due)) fail("Malformed taskboard database");
    if (item.status === "done" ? !isIsoTimestamp(item.completedAt) : item.completedAt !== undefined) {
      fail("Malformed taskboard database");
    }
  }
  if ((value.nextId as number) <= maxId) fail("Malformed taskboard database");
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await readFile(databasePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    fail(`Cannot read database: ${(error as Error).message}`);
  }
  try {
    return validateDatabase(JSON.parse(text!));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("Malformed taskboard database");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const parent = dirname(databasePath);
  await mkdir(parent, { recursive: true });
  const temporaryPath = `${databasePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try { await unlink(temporaryPath); } catch {}
    fail(`Cannot write database: ${(error as Error).message}`);
  }
}

function parseFlags(args: string[], allowed: Set<string>): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    if (!allowed.has(argument)) fail(`Unknown flag: ${argument}`);
    if (flags.has(argument)) fail(`Duplicate flag: ${argument}`);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${argument}`);
    flags.set(argument, value);
  }
  return { flags, positional };
}

function requireNoPositionals(positional: string[]): void {
  if (positional.length > 0) fail(`Unexpected argument: ${positional[0]}`);
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function todayLocal(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function execute(args: string[]): Promise<unknown> {
  const command = args[0];
  if (!command) fail("Missing command");

  if (command === "add") {
    const { flags, positional } = parseFlags(args.slice(1), new Set(["--title", "--tags", "--due"]));
    requireNoPositionals(positional);
    const title = flags.get("--title")?.trim();
    if (!title) fail("--title is required and must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !validDate(due)) fail("--due must be a valid YYYY-MM-DD date");
    const tagsValue = flags.get("--tags");
    const tags = tagsValue === undefined
      ? []
      : [...new Set(tagsValue.split(",").map(normalizeTag).filter(Boolean))];

    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId++,
      title,
      status: "open",
      tags,
      ...(due === undefined ? {} : { due }),
      createdAt: new Date().toISOString(),
    };
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const { flags, positional } = parseFlags(args.slice(1), new Set(["--status", "--tag", "--overdue"]));
    requireNoPositionals(positional);
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
    const tag = flags.get("--tag");
    if (tag !== undefined && normalizeTag(tag) === "") fail("--tag must not be empty");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !validDate(overdue)) fail("--overdue must be a valid YYYY-MM-DD date");

    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(normalizeTag(tag)))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    const { flags, positional } = parseFlags(args.slice(1), new Set());
    void flags;
    if (positional.length !== 1) fail("Usage: done ID");
    const id = parseId(positional[0]);
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

  if (command === "delete") {
    const { flags, positional } = parseFlags(args.slice(1), new Set());
    void flags;
    if (positional.length !== 1) fail("Usage: delete ID");
    const id = parseId(positional[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`Task ${id} not found`);
    const [deleted] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return deleted;
  }

  if (command === "stats") {
    const { positional } = parseFlags(args.slice(1), new Set());
    requireNoPositionals(positional);
    const tasks = (await loadDatabase()).tasks;
    const today = todayLocal();
    const open = tasks.filter((task) => task.status === "open").length;
    return {
      total: tasks.length,
      open,
      done: tasks.length - open,
      overdue: tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`Unknown command: ${command}`);
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
