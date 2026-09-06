import { rename, unlink } from "node:fs/promises";
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
  nextId: number;
  tasks: Task[];
}

type ParsedCommand =
  | { name: "add"; title: string; tags: string[]; due?: string }
  | { name: "list"; status?: Status; tag?: string; overdue?: string }
  | { name: "done"; id: number }
  | { name: "delete"; id: number }
  | { name: "stats" };

class CliError extends Error {}

const args = process.argv.slice(2);
const databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of value.split(",")) {
    const tag = normalizeTag(rawTag);
    if (tag !== "" && !seen.has(tag)) {
      tags.push(tag);
      seen.add(tag);
    }
  }
  return tags;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) {
    fail(`Missing value for ${flag}`);
  }
  return value;
}

function parseFlags(argv: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag.startsWith("--") || !allowed.has(flag)) {
      fail(`Unknown flag or argument: ${flag}`);
    }
    if (flags.has(flag)) fail(`Duplicate flag: ${flag}`);
    flags.set(flag, requireValue(argv, index, flag));
  }
  return flags;
}

function parseId(value: string | undefined, command: string): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    fail(`${command} requires a positive integer ID`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail(`Invalid task ID: ${value}`);
  return id;
}

function parseCommand(argv: string[]): ParsedCommand {
  const [command, ...rest] = argv;
  if (!command) fail("Missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    if (!flags.has("--title")) fail("add requires --title");
    const title = flags.get("--title")!.trim();
    if (title === "") fail("Title must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isDate(due)) fail(`Invalid due date: ${due}`);
    return {
      name: "add",
      title,
      tags: normalizeTags(flags.get("--tags") ?? ""),
      ...(due === undefined ? {} : { due }),
    };
  }

  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail(`Invalid status: ${status}`);
    }
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail(`Invalid overdue date: ${overdue}`);
    const rawTag = flags.get("--tag");
    const tag = rawTag === undefined ? undefined : normalizeTag(rawTag);
    if (tag === "") fail("Tag must not be empty");
    return {
      name: "list",
      ...(status === undefined ? {} : { status }),
      ...(tag === undefined ? {} : { tag }),
      ...(overdue === undefined ? {} : { overdue }),
    };
  }

  if (command === "done" || command === "delete") {
    if (rest.length !== 1) fail(`${command} requires exactly one ID`);
    return { name: command, id: parseId(rest[0], command) };
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`Unknown flag or argument: ${rest[0]}`);
    return { name: "stats" };
  }

  fail(`Unknown command: ${command}`);
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = new Set(Object.keys(value));
  const required = ["id", "title", "status", "createdAt", "tags"];
  if (required.some((key) => !keys.has(key))) return false;
  if (![...keys].every((key) => [...required, "due", "completedAt"].includes(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) return false;
  const normalized = (value.tags as string[]).map(normalizeTag);
  if (normalized.some((tag) => tag === "") || new Set(normalized).size !== normalized.length) return false;
  if (!(value.tags as string[]).every((tag, index) => tag === normalized[index])) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && !isIsoTimestamp(value.completedAt)) return false;
  return true;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "nextId" && key !== "tasks")) {
    fail("Malformed task database");
  }
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("Malformed task database");
  }
  if (!value.tasks.every(validateTask)) fail("Malformed task database");
  const ids = (value.tasks as Task[]).map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (value.nextId as number))) {
    fail("Malformed task database");
  }
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  const file = Bun.file(databasePath);
  if (!(await file.exists())) return { nextId: 1, tasks: [] };
  let contents: string;
  try {
    contents = await file.text();
  } catch {
    fail(`Cannot read task database: ${databasePath}`);
  }
  try {
    return validateDatabase(JSON.parse(contents));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("Malformed task database");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = join(
    directory,
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporaryPath, databasePath);
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    fail(`Cannot write task database: ${databasePath}`);
  }
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function execute(command: ParsedCommand): Promise<unknown> {
  const database = await loadDatabase();

  if (command.name === "add") {
    const task: Task = {
      id: database.nextId,
      title: command.title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: command.tags,
      ...(command.due === undefined ? {} : { due: command.due }),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command.name === "list") {
    return database.tasks
      .filter((task) => command.status === undefined || task.status === command.status)
      .filter((task) => command.tag === undefined || task.tags.includes(command.tag))
      .filter(
        (task) =>
          command.overdue === undefined ||
          (task.status === "open" && task.due !== undefined && task.due < command.overdue),
      )
      .sort((left, right) => left.id - right.id);
  }

  if (command.name === "done") {
    const task = database.tasks.find((candidate) => candidate.id === command.id);
    if (!task) fail(`Task not found: ${command.id}`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command.name === "delete") {
    const index = database.tasks.findIndex((task) => task.id === command.id);
    if (index === -1) fail(`Task not found: ${command.id}`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  const today = localToday();
  return {
    total: database.tasks.length,
    open: database.tasks.filter((task) => task.status === "open").length,
    done: database.tasks.filter((task) => task.status === "done").length,
    overdue: database.tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length,
  };
}

try {
  const command = parseCommand(args);
  console.log(JSON.stringify(await execute(command)));
} catch (error) {
  const message = error instanceof CliError ? error.message : "Unexpected error";
  console.log(JSON.stringify({ error: message }));
  console.error(message);
  process.exitCode = 1;
}
