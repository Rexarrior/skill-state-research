import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, basename, join } from "node:path";

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
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateTask(value: unknown): value is Task {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !["id", "title", "status", "tags", "due", "createdAt", "completedAt"].includes(key))) {
    return false;
  }
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== tag.trim().toLowerCase())) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && (typeof value.due !== "string" || !isValidDate(value.due))) return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) return false;
  if (value.status === "done" && value.completedAt === undefined) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  return true;
}

function readDatabase(): Database {
  if (!existsSync(databasePath)) return { nextId: 1, tasks: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(databasePath, "utf8"));
  } catch (error) {
    throw new CliError(`Cannot read database: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed) || Object.keys(parsed).some((key) => !["nextId", "tasks"].includes(key))) {
    throw new CliError("Malformed database");
  }
  if (!Number.isSafeInteger(parsed.nextId) || (parsed.nextId as number) < 1 || !Array.isArray(parsed.tasks) || !parsed.tasks.every(validateTask)) {
    throw new CliError("Malformed database");
  }
  const tasks = parsed.tasks as Task[];
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (parsed as unknown as Database).nextId)) {
    throw new CliError("Malformed database");
  }
  return parsed as unknown as Database;
}

function writeDatabase(database: Database): void {
  const directory = dirname(databasePath);
  const temporary = join(directory, `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(database, null, 2)}\n`, "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, databasePath);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch {}
    throw new CliError(`Cannot write database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseArguments(args: string[], allowedFlags: Set<string>, positionalCount: number): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    if (!allowedFlags.has(name)) throw new CliError(`Unknown flag: --${name}`);
    if (flags.has(name)) throw new CliError(`Duplicate flag: --${name}`);
    const value = equals === -1 ? args[++index] : argument.slice(equals + 1);
    if (value === undefined || (equals === -1 && value.startsWith("--"))) throw new CliError(`Missing value for --${name}`);
    flags.set(name, value);
  }
  if (positional.length !== positionalCount) throw new CliError("Invalid number of arguments");
  return { flags, positional };
}

function requirePositiveId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new CliError(`Invalid task ID: ${value}`);
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new CliError(`Invalid task ID: ${value}`);
  return id;
}

function normalizeTag(value: string): string {
  const tag = value.trim().toLowerCase();
  if (!tag) throw new CliError("Tags cannot be empty");
  return tag;
}

function parseDate(value: string, label: string): string {
  if (!isValidDate(value)) throw new CliError(`Invalid ${label}: ${value}`);
  return value;
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function run(argv: string[]): unknown {
  const command = argv[0];
  if (!command) throw new CliError("Missing command");

  if (command === "add") {
    const { flags } = parseArguments(argv.slice(1), new Set(["title", "tags", "due"]), 0);
    const title = flags.get("title")?.trim();
    if (!title) throw new CliError("--title is required and cannot be empty");
    const tags = flags.has("tags")
      ? [...new Set(flags.get("tags")!.split(",").map(normalizeTag))]
      : [];
    const due = flags.has("due") ? parseDate(flags.get("due")!, "due date") : undefined;
    const database = readDatabase();
    const task: Task = { id: database.nextId, title, status: "open", tags, ...(due ? { due } : {}), createdAt: new Date().toISOString() };
    database.nextId += 1;
    database.tasks.push(task);
    writeDatabase(database);
    return task;
  }

  if (command === "list") {
    const { flags } = parseArguments(argv.slice(1), new Set(["status", "tag", "overdue"]), 0);
    const status = flags.get("status");
    if (status !== undefined && status !== "open" && status !== "done") throw new CliError(`Invalid status: ${status}`);
    const tag = flags.has("tag") ? normalizeTag(flags.get("tag")!) : undefined;
    const overdue = flags.has("overdue") ? parseDate(flags.get("overdue")!, "overdue date") : undefined;
    return readDatabase().tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    const { positional } = parseArguments(argv.slice(1), new Set(), 1);
    const id = requirePositiveId(positional[0]);
    const database = readDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new CliError(`Task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      writeDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    const { positional } = parseArguments(argv.slice(1), new Set(), 1);
    const id = requirePositiveId(positional[0]);
    const database = readDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) throw new CliError(`Task ${id} not found`);
    const [deleted] = database.tasks.splice(index, 1);
    writeDatabase(database);
    return deleted;
  }

  if (command === "stats") {
    parseArguments(argv.slice(1), new Set(), 0);
    const tasks = readDatabase().tasks;
    const today = localToday();
    const open = tasks.filter((task) => task.status === "open").length;
    return {
      total: tasks.length,
      open,
      done: tasks.length - open,
      overdue: tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  throw new CliError(`Unknown command: ${command}`);
}

try {
  const result = run(Bun.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
}
