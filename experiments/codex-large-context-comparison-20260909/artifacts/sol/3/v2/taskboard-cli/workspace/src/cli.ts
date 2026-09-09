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

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) return false;
  if (value.due !== undefined && (typeof value.due !== "string" || !isValidDate(value.due))) return false;
  if (value.completedAt !== undefined && (typeof value.completedAt !== "string" || Number.isNaN(Date.parse(value.completedAt)))) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && typeof value.completedAt !== "string") return false;
  return true;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    if (isNotFound(error)) return { nextId: 1, tasks: [] };
    fail(`cannot read database: ${errorMessage(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("malformed database: invalid JSON");
  }

  if (!isRecord(value) || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks) || !value.tasks.every(validateTask)) {
    fail("malformed database: invalid structure");
  }

  const ids = new Set<number>();
  for (const task of value.tasks as Task[]) {
    if (ids.has(task.id)) fail("malformed database: duplicate task id");
    ids.add(task.id);
  }
  const maxId = (value.tasks as Task[]).reduce((max, task) => Math.max(max, task.id), 0);
  if ((value.nextId as number) <= maxId) fail("malformed database: invalid nextId");

  return value as unknown as Database;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporary = join(directory, `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await Bun.write(temporary, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporary, databasePath);
  } catch (error) {
    try { await unlink(temporary); } catch {}
    fail(`cannot write database: ${errorMessage(error)}`);
  }
}

function parseFlags(args: string[], allowed: Set<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) fail(`unknown flag: ${flag ?? ""}`);
    if (flags.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function normalizedTags(value: string | undefined): string[] {
  if (value === undefined) return [];
  const unique = new Set<string>();
  for (const raw of value.split(",")) {
    const tag = raw.trim().toLowerCase();
    if (tag !== "") unique.add(tag);
  }
  return [...unique];
}

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function execute(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title")?.trim();
    if (title === undefined) fail("missing required flag: --title");
    if (title === "") fail("title must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isValidDate(due)) fail("due date must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId++,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: normalizedTags(flags.get("--tags")),
      ...(due === undefined ? {} : { due }),
    };
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("status must be open or done");
    const tag = flags.get("--tag")?.trim().toLowerCase();
    if (flags.has("--tag") && tag === "") fail("tag must not be empty");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isValidDate(overdue)) fail("overdue date must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("usage: done ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`task not found: ${id}`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("usage: delete ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index === -1) fail(`task not found: ${id}`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`unknown flag: ${rest[0]}`);
    const database = await loadDatabase();
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open").length;
    return {
      total: database.tasks.length,
      open,
      done: database.tasks.length - open,
      overdue: database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`unknown command: ${command}`);
}

try {
  const result = await execute(process.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof CliError ? error.message : `unexpected error: ${errorMessage(error)}`);
  process.exitCode = 1;
}
