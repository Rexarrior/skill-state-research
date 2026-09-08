import { open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

type Status = "open" | "done";

export interface Task {
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

const databasePath = () => process.env.TASKBOARD_FILE || join(process.cwd(), ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = new Set(Object.keys(value));
  for (const required of ["id", "title", "status", "createdAt", "tags"]) {
    if (!keys.delete(required)) return false;
  }
  keys.delete("due");
  keys.delete("completedAt");
  if (keys.size > 0) return false;

  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) return false;
  const normalized = value.tags.map((tag) => normalizeTag(tag));
  if (normalized.some((tag) => tag === "") || new Set(normalized).size !== normalized.length) return false;
  if (normalized.some((tag, index) => tag !== value.tags[index])) return false;
  if (value.due !== undefined && !isValidDate(value.due)) return false;
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && value.completedAt === undefined) return false;
  return true;
}

function validateDatabase(value: unknown): value is Database {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => key !== "nextId" && key !== "tasks")) return false;
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    return false;
  }
  if (!value.tasks.every(validateTask)) return false;
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) return false;
  return ids.every((id) => id < (value.nextId as number));
}

async function loadDatabase(path: string): Promise<Database> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    fail(`Malformed task database: ${path}`);
  }
  if (!validateDatabase(value)) fail(`Malformed task database: ${path}`);
  return value;
}

async function saveDatabase(path: string, database: Database): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(database, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseFlags(
  args: string[],
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name?.startsWith("--") || !allowed.has(name)) fail(`Unknown flag or argument: ${name ?? ""}`);
    if (flags.has(name)) fail(`Duplicate flag: ${name}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${name}`);
    flags.set(name, value);
  }
  for (const name of required) {
    if (!flags.has(name)) fail(`Missing required flag: ${name}`);
  }
  return flags;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function localDate(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function execute(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("Missing command");
  const path = databasePath();

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]), new Set(["--title"]));
    const title = flags.get("--title")!.trim();
    if (!title) fail("Title must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isValidDate(due)) fail("Due date must be a valid YYYY-MM-DD date");
    const tags = [...new Set((flags.get("--tags") ?? "").split(",").map(normalizeTag).filter(Boolean))];
    const database = await loadDatabase(path);
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags,
      ...(due === undefined ? {} : { due }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(path, database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("Status must be open or done");
    }
    const tagValue = flags.get("--tag");
    const tag = tagValue === undefined ? undefined : normalizeTag(tagValue);
    if (tag === "") fail("Tag must not be empty");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isValidDate(overdue)) fail("Overdue date must be a valid YYYY-MM-DD date");
    const database = await loadDatabase(path);
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("Usage: done ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase(path);
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`Task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(path, database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("Usage: delete ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase(path);
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index === -1) fail(`Task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(path, database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`Unknown flag or argument: ${rest[0]}`);
    const database = await loadDatabase(path);
    const today = localDate();
    return {
      total: database.tasks.length,
      open: database.tasks.filter((task) => task.status === "open").length,
      done: database.tasks.filter((task) => task.status === "done").length,
      overdue: database.tasks.filter(
        (task) => task.status === "open" && task.due !== undefined && task.due < today,
      ).length,
    };
  }

  fail(`Unknown command: ${command}`);
}

try {
  const result = await execute(Bun.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
}
