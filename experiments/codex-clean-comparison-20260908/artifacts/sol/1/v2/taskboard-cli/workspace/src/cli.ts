import { rename, unlink } from "node:fs/promises";

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

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function requireDate(value: string, flag: string): string {
  if (!isDate(value)) fail(`${flag} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function validateTask(value: unknown, index: number): Task {
  if (!isPlainObject(value)) fail(`malformed database: task ${index} is not an object`);
  const { id, title, status, tags, due, createdAt, completedAt } = value;
  if (!Number.isSafeInteger(id) || (id as number) < 1) fail(`malformed database: invalid task id`);
  if (typeof title !== "string" || title.trim() === "") fail(`malformed database: invalid task title`);
  if (status !== "open" && status !== "done") fail(`malformed database: invalid task status`);
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string" || tag === "")) {
    fail(`malformed database: invalid task tags`);
  }
  if (new Set(tags).size !== tags.length) fail(`malformed database: duplicate task tags`);
  if (due !== undefined && !isDate(due)) fail(`malformed database: invalid due date`);
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    fail(`malformed database: invalid createdAt`);
  }
  if (completedAt !== undefined && (typeof completedAt !== "string" || Number.isNaN(Date.parse(completedAt)))) {
    fail(`malformed database: invalid completedAt`);
  }
  if (status === "open" && completedAt !== undefined) fail(`malformed database: open task has completedAt`);
  if (status === "done" && completedAt === undefined) fail(`malformed database: done task lacks completedAt`);
  return value as unknown as Task;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    if (isPlainObject(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    fail(`cannot read database: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("malformed database: invalid JSON");
  }
  if (!isPlainObject(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("malformed database: invalid document structure");
  }
  const tasks = value.tasks.map(validateTask);
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) fail("malformed database: duplicate task ids");
  if (ids.some((id) => id >= (value.nextId as number))) fail("malformed database: nextId does not exceed all task ids");
  return { version: 1, nextId: value.nextId as number, tasks };
}

async function saveDatabase(database: Database): Promise<void> {
  const separator = databasePath.lastIndexOf("/");
  const directory = separator < 0 ? "." : databasePath.slice(0, separator) || "/";
  const name = separator < 0 ? databasePath : databasePath.slice(separator + 1);
  const temporaryPath = `${directory}/${name}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try { await unlink(temporaryPath); } catch {}
    fail(`cannot write database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface ParsedArguments {
  positionals: string[];
  flags: Map<string, string>;
}

function parseArguments(args: string[], allowedFlags: Set<string>): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (!allowedFlags.has(token)) fail(`unknown flag: ${token}`);
    if (flags.has(token)) fail(`flag specified more than once: ${token}`);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${token}`);
    flags.set(token, value);
  }
  return { positionals, flags };
}

function normalizeTags(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [...new Set(value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function requireNoPositionals(positionals: string[]): void {
  if (positionals.length > 0) fail(`unexpected argument: ${positionals[0]}`);
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a safe positive integer");
  return id;
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const command = args[0];
  if (!command) fail("missing command");

  if (command === "add") {
    const parsed = parseArguments(args.slice(1), new Set(["--title", "--tags", "--due"]));
    requireNoPositionals(parsed.positionals);
    const title = parsed.flags.get("--title");
    if (title === undefined) fail("missing required flag: --title");
    if (title.trim() === "") fail("title must not be empty");
    const dueValue = parsed.flags.get("--due");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title: title.trim(),
      status: "open",
      tags: normalizeTags(parsed.flags.get("--tags")),
      ...(dueValue === undefined ? {} : { due: requireDate(dueValue, "--due") }),
      createdAt: new Date().toISOString(),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const parsed = parseArguments(args.slice(1), new Set(["--status", "--tag", "--overdue"]));
    requireNoPositionals(parsed.positionals);
    const status = parsed.flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
    const tagValue = parsed.flags.get("--tag");
    if (tagValue !== undefined && tagValue.trim() === "") fail("--tag must not be empty");
    const tag = tagValue?.trim().toLowerCase();
    const overdueValue = parsed.flags.get("--overdue");
    const overdue = overdueValue === undefined ? undefined : requireDate(overdueValue, "--overdue");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    const parsed = parseArguments(args.slice(1), new Set());
    if (parsed.positionals.length !== 1) fail("usage: done ID");
    const id = parseId(parsed.positionals[0]);
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
    const parsed = parseArguments(args.slice(1), new Set());
    if (parsed.positionals.length !== 1) fail("usage: delete ID");
    const id = parseId(parsed.positionals[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index < 0) fail(`task not found: ${id}`);
    const [deleted] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return deleted;
  }

  if (command === "stats") {
    const parsed = parseArguments(args.slice(1), new Set());
    requireNoPositionals(parsed.positionals);
    const tasks = (await loadDatabase()).tasks;
    const today = localToday();
    return {
      total: tasks.length,
      open: tasks.filter((task) => task.status === "open").length,
      done: tasks.filter((task) => task.status === "done").length,
      overdue: tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(`unknown command: ${command}`);
}

try {
  const result = await run(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.log("null");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
