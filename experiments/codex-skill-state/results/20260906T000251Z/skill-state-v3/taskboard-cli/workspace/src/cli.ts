import { rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

const databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== tag.trim().toLowerCase())) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && !isIsoTimestamp(value.completedAt)) return false;
  return true;
}

function validateDatabase(value: unknown): asserts value is Database {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("Malformed taskboard database");
  }
  const allowed = new Set(["version", "nextId", "tasks"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || !value.tasks.every(validateTask)) {
    fail("Malformed taskboard database");
  }
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (value.nextId as number))) {
    fail("Malformed taskboard database");
  }
}

async function readDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("Malformed taskboard database");
  }
  validateDatabase(value);
  return value;
}

async function writeDatabase(database: Database): Promise<void> {
  const temporary = `${databasePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporary, databasePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function parseFlags(args: string[], definitions: Record<string, true>): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || definitions[flag] !== true) fail(`Unknown flag: ${flag ?? ""}`);
    if (flag in result) fail(`Duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    result[flag] = value;
  }
  return result;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function normalizeTags(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [...new Set(value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function localToday(): string {
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
    const flags = parseFlags(args.slice(1), { "--title": true, "--tags": true, "--due": true });
    if (!("--title" in flags)) fail("Missing required flag: --title");
    const title = flags["--title"].trim();
    if (!title) fail("Title must not be empty");
    const due = flags["--due"];
    if (due !== undefined && !isDate(due)) fail("Due date must be a valid YYYY-MM-DD date");
    const database = await readDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: normalizeTags(flags["--tags"]),
      ...(due === undefined ? {} : { due }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await writeDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(args.slice(1), { "--status": true, "--tag": true, "--overdue": true });
    const status = flags["--status"];
    if (status !== undefined && status !== "open" && status !== "done") fail("Status must be open or done");
    const overdue = flags["--overdue"];
    if (overdue !== undefined && !isDate(overdue)) fail("Overdue date must be a valid YYYY-MM-DD date");
    const tag = flags["--tag"]?.trim().toLowerCase();
    if (flags["--tag"] !== undefined && !tag) fail("Tag must not be empty");
    const database = await readDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (args.length !== 2) fail(args.length > 2 ? `Unknown argument: ${args[2]}` : "Missing task ID");
    const id = parseId(args[1]);
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

  if (command === "delete") {
    if (args.length !== 2) fail(args.length > 2 ? `Unknown argument: ${args[2]}` : "Missing task ID");
    const id = parseId(args[1]);
    const database = await readDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index < 0) fail(`Task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await writeDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (args.length !== 1) fail(`Unknown argument: ${args[1]}`);
    const database = await readDatabase();
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open").length;
    return {
      total: database.tasks.length,
      open,
      done: database.tasks.length - open,
      overdue: database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`Unknown command: ${command}`);
}

try {
  const result = await execute(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.log("null");
  console.error(error instanceof CliError ? error.message : `Taskboard error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
