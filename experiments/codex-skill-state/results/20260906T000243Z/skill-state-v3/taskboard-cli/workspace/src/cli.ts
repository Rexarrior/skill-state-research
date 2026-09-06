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

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function parseDate(value: string, label = "date"): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${label} must use YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    fail(`${label} is not a valid calendar date`);
  }
  return value;
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const tag = normalizeTag(raw);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

function validateTask(value: unknown, index: number): Task {
  if (!isRecord(value)) fail(`database task ${index} is invalid`);
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`database task ${index} has unknown field: ${key}`);
  }
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) {
    fail(`database task ${index} has invalid id`);
  }
  if (typeof value.title !== "string" || value.title.trim() === "") {
    fail(`database task ${index} has invalid title`);
  }
  if (value.status !== "open" && value.status !== "done") {
    fail(`database task ${index} has invalid status`);
  }
  if (!isIsoTimestamp(value.createdAt)) {
    fail(`database task ${index} has invalid createdAt`);
  }
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || !tag)) {
    fail(`database task ${index} has invalid tags`);
  }
  if (new Set(value.tags).size !== value.tags.length || value.tags.some((tag) => normalizeTag(tag) !== tag)) {
    fail(`database task ${index} has non-normalized tags`);
  }
  if (value.due !== undefined) parseDate(String(value.due), `database task ${index} due`);
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) {
    fail(`database task ${index} has invalid completedAt`);
  }
  if (value.status === "done" && value.completedAt === undefined) {
    fail(`database task ${index} is done without completedAt`);
  }
  if (value.status === "open" && value.completedAt !== undefined) {
    fail(`database task ${index} is open with completedAt`);
  }
  return value as unknown as Task;
}

async function loadDatabase(): Promise<Database> {
  let source: string;
  try {
    source = await readFile(databasePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail("database contains malformed JSON");
  }
  if (!isRecord(value) || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("database has an invalid structure");
  }
  const tasks = value.tasks.map(validateTask);
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) fail("database contains duplicate task ids");
  const maxId = tasks.reduce((max, task) => Math.max(max, task.id), 0);
  if ((value.nextId as number) <= maxId) fail("database nextId is invalid");
  return { nextId: value.nextId as number, tasks };
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = join(
    directory,
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle;
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
    throw error;
  }
}

function parseFlags(args: string[], allowed: Set<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--")) fail(`unexpected argument: ${flag ?? ""}`);
    if (!allowed.has(flag)) fail(`unknown flag: ${flag}`);
    if (flags.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function requireId(args: string[]): number {
  if (args.length !== 1) fail("command requires exactly one task ID");
  if (!/^[1-9]\d*$/.test(args[0])) fail("task ID must be a positive integer");
  const id = Number(args[0]);
  if (!Number.isSafeInteger(id)) fail("task ID is too large");
  return id;
}

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title");
    if (title === undefined) fail("missing required flag: --title");
    const normalizedTitle = title.trim();
    if (!normalizedTitle) fail("title must not be empty");
    const due = flags.has("--due") ? parseDate(flags.get("--due")!, "due date") : undefined;
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title: normalizedTitle,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: flags.has("--tags") ? normalizeTags(flags.get("--tags")!) : [],
      ...(due ? { due } : {}),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("status must be open or done");
    }
    const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag")!) : undefined;
    if (tag === "") fail("tag must not be empty");
    const overdue = flags.has("--overdue")
      ? parseDate(flags.get("--overdue")!, "overdue date")
      : undefined;
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    const id = requireId(rest);
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    const id = requireId(rest);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index === -1) fail(`task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length) fail(`unexpected argument: ${rest[0]}`);
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
  const result = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.stderr.write(`taskboard: ${message}\n`);
  process.exitCode = 1;
}
