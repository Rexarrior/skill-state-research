import { dirname, basename, join } from "node:path";
import { rename, unlink } from "node:fs/promises";

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

const databasePath = process.env.TASKBOARD_FILE || join(process.cwd(), ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("Malformed taskboard database");
  }

  const seenIds = new Set<number>();
  let highestId = 0;
  for (const item of value.tasks) {
    if (!isRecord(item) || !Number.isSafeInteger(item.id) || (item.id as number) < 1 ||
        typeof item.title !== "string" || item.title.trim() === "" ||
        (item.status !== "open" && item.status !== "done") || !isIsoTimestamp(item.createdAt) ||
        !Array.isArray(item.tags) || !item.tags.every((tag) => typeof tag === "string" && tag !== "" && tag === tag.trim().toLowerCase()) ||
        new Set(item.tags).size !== item.tags.length ||
        (item.due !== undefined && !isValidDate(item.due)) ||
        (item.status === "done" ? !isIsoTimestamp(item.completedAt) : item.completedAt !== undefined)) {
      fail("Malformed taskboard database");
    }
    const id = item.id as number;
    if (seenIds.has(id)) fail("Malformed taskboard database");
    seenIds.add(id);
    highestId = Math.max(highestId, id);
  }
  if ((value.nextId as number) <= highestId) fail("Malformed taskboard database");
  return value as unknown as Database;
}

async function readDatabase(): Promise<Database> {
  const file = Bun.file(databasePath);
  if (!(await file.exists())) return { nextId: 1, tasks: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    fail("Malformed taskboard database");
  }
  return validateDatabase(parsed);
}

async function writeDatabase(database: Database): Promise<void> {
  const temporaryPath = join(
    dirname(databasePath),
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporaryPath, databasePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseId(raw: string | undefined): number {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) fail("ID must be a positive integer");
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function normalizeTag(tag: string): string {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) fail("Tag must not be empty");
  return normalized;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
  return value;
}

function rejectDuplicate(seen: Set<string>, flag: string): void {
  if (seen.has(flag)) fail(`Duplicate flag: ${flag}`);
  seen.add(flag);
}

async function add(args: string[]): Promise<Task> {
  let title: string | undefined;
  let tags: string[] = [];
  let due: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag.startsWith("--")) fail(`Unexpected argument: ${flag}`);
    rejectDuplicate(seen, flag);
    const value = requireValue(args, index, flag);
    if (flag === "--title") title = value.trim();
    else if (flag === "--tags") {
      tags = [...new Set(value.split(",").map(normalizeTag))];
    } else if (flag === "--due") {
      if (!isValidDate(value)) fail("Due date must be a valid YYYY-MM-DD date");
      due = value;
    } else fail(`Unknown flag: ${flag}`);
  }
  if (title === undefined) fail("Missing required flag: --title");
  if (!title) fail("Title must not be empty");

  const database = await readDatabase();
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
  await writeDatabase(database);
  return task;
}

async function list(args: string[]): Promise<Task[]> {
  let status: Status | undefined;
  let tag: string | undefined;
  let overdue: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag.startsWith("--")) fail(`Unexpected argument: ${flag}`);
    rejectDuplicate(seen, flag);
    const value = requireValue(args, index, flag);
    if (flag === "--status") {
      if (value !== "open" && value !== "done") fail("Status must be open or done");
      status = value;
    } else if (flag === "--tag") tag = normalizeTag(value);
    else if (flag === "--overdue") {
      if (!isValidDate(value)) fail("Overdue date must be a valid YYYY-MM-DD date");
      overdue = value;
    } else fail(`Unknown flag: ${flag}`);
  }

  const database = await readDatabase();
  return database.tasks
    .filter((task) => status === undefined || task.status === status)
    .filter((task) => tag === undefined || task.tags.includes(tag))
    .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
    .sort((left, right) => left.id - right.id);
}

async function markDone(args: string[]): Promise<Task> {
  if (args.length !== 1) fail("Usage: done ID");
  const id = parseId(args[0]);
  const database = await readDatabase();
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`Task ${id} not found`);
  if (task.status === "open") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    await writeDatabase(database);
  }
  return task;
}

async function deleteTask(args: string[]): Promise<Task> {
  if (args.length !== 1) fail("Usage: delete ID");
  const id = parseId(args[0]);
  const database = await readDatabase();
  const index = database.tasks.findIndex((task) => task.id === id);
  if (index < 0) fail(`Task ${id} not found`);
  const [deleted] = database.tasks.splice(index, 1);
  await writeDatabase(database);
  return deleted;
}

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function stats(args: string[]): Promise<{ total: number; open: number; done: number; overdue: number }> {
  if (args.length !== 0) fail(`Unexpected argument: ${args[0]}`);
  const tasks = (await readDatabase()).tasks;
  const today = localToday();
  return {
    total: tasks.length,
    open: tasks.filter((task) => task.status === "open").length,
    done: tasks.filter((task) => task.status === "done").length,
    overdue: tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
  };
}

async function main(): Promise<unknown> {
  const [command, ...args] = Bun.argv.slice(2);
  if (command === "add") return add(args);
  if (command === "list") return list(args);
  if (command === "done") return markDone(args);
  if (command === "delete") return deleteTask(args);
  if (command === "stats") return stats(args);
  fail(command === undefined ? "Missing command" : `Unknown command: ${command}`);
}

try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(message);
  process.exitCode = 1;
}
