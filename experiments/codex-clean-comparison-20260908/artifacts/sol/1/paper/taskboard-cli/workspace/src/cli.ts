import { rename, readFile, unlink, writeFile } from "node:fs/promises";
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

const databasePath = process.env.TASKBOARD_FILE || join(process.cwd(), ".taskboard.json");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function validateTask(value: unknown): value is Task {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["id", "title", "status", "tags", "due", "createdAt", "completedAt"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== tag.trim().toLowerCase())) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isValidDate(value.due)) return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && value.completedAt === undefined) return false;
  return true;
}

function validateDatabase(value: unknown): value is Database {
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "nextId" && key !== "tasks")) return false;
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) return false;
  if (!value.tasks.every(validateTask)) return false;
  const ids = value.tasks.map((task) => task.id);
  return new Set(ids).size === ids.length && ids.every((id) => id < (value.nextId as number));
}

async function loadDatabase(): Promise<Database> {
  let source: string;
  try {
    source = await readFile(databasePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, tasks: [] };
    throw new CliError(`cannot read database: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new CliError("database is malformed: invalid JSON");
  }
  if (!validateDatabase(parsed)) throw new CliError("database is malformed: invalid structure");
  return parsed;
}

async function saveDatabase(database: Database): Promise<void> {
  const temporaryPath = join(
    dirname(databasePath),
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // There may be no temporary file to clean up.
    }
    throw new CliError(`cannot write database: ${(error as Error).message}`);
  }
}

interface ParsedArguments {
  flags: Map<string, string>;
  positionals: string[];
}

function parseArguments(args: string[], allowedFlags: Set<string>): ParsedArguments {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (!name || name.includes("=") || !allowedFlags.has(name)) throw new CliError(`unknown flag: ${argument}`);
    if (flags.has(name)) throw new CliError(`duplicate flag: --${name}`);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new CliError(`missing value for --${name}`);
    flags.set(name, value);
  }
  return { flags, positionals };
}

function normalizeTags(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [...new Set(value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function requireDate(value: string, label: string): string {
  if (!isValidDate(value)) throw new CliError(`${label} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function requireId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) throw new CliError("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new CliError("ID must be a positive integer");
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
  const command = args[0];
  if (!command) throw new CliError("missing command");

  if (command === "add") {
    const { flags, positionals } = parseArguments(args.slice(1), new Set(["title", "tags", "due"]));
    if (positionals.length) throw new CliError(`unexpected argument: ${positionals[0]}`);
    const rawTitle = flags.get("title");
    if (rawTitle === undefined) throw new CliError("missing required flag: --title");
    const title = rawTitle.trim();
    if (!title) throw new CliError("title must not be empty");
    const dueValue = flags.get("due");
    const due = dueValue === undefined ? undefined : requireDate(dueValue, "due date");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      tags: normalizeTags(flags.get("tags")),
      ...(due === undefined ? {} : { due }),
      createdAt: new Date().toISOString(),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const { flags, positionals } = parseArguments(args.slice(1), new Set(["status", "tag", "overdue"]));
    if (positionals.length) throw new CliError(`unexpected argument: ${positionals[0]}`);
    const status = flags.get("status");
    if (status !== undefined && status !== "open" && status !== "done") throw new CliError("status must be open or done");
    const tag = flags.get("tag")?.trim().toLowerCase();
    if (flags.has("tag") && !tag) throw new CliError("tag must not be empty");
    const overdueValue = flags.get("overdue");
    const overdue = overdueValue === undefined ? undefined : requireDate(overdueValue, "overdue date");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    const { flags, positionals } = parseArguments(args.slice(1), new Set());
    void flags;
    if (positionals.length !== 1) throw new CliError("done requires exactly one ID");
    const id = requireId(positionals[0]);
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new CliError(`task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    const { flags, positionals } = parseArguments(args.slice(1), new Set());
    void flags;
    if (positionals.length !== 1) throw new CliError("delete requires exactly one ID");
    const id = requireId(positionals[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) throw new CliError(`task ${id} not found`);
    const [deleted] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return deleted;
  }

  if (command === "stats") {
    const { flags, positionals } = parseArguments(args.slice(1), new Set());
    void flags;
    if (positionals.length) throw new CliError(`unexpected argument: ${positionals[0]}`);
    const database = await loadDatabase();
    const today = localDate();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length;
    return { total: database.tasks.length, open, done, overdue };
  }

  throw new CliError(`unknown command: ${command}`);
}

try {
  const result = await execute(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`taskboard: ${message}\n`);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
}
