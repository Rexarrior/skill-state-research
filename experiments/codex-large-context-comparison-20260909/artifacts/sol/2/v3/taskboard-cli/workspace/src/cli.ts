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
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function parseDate(value: string, label = "date"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) fail(`${label} must use YYYY-MM-DD`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    fail(`${label} is not a valid calendar date`);
  }
  return value;
}

function normalizeTag(value: string): string {
  const tag = value.trim().toLowerCase();
  if (!tag) fail("tags must not be empty");
  return tag;
}

function parseTags(value: string): string[] {
  return [...new Set(value.split(",").map(normalizeTag))];
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = new Set(Object.keys(value));
  const allowed = new Set([
    "id",
    "title",
    "status",
    "tags",
    "due",
    "createdAt",
    "completedAt",
  ]);
  if ([...keys].some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) return false;
  const tags = value.tags as string[];
  if (tags.some((tag) => tag === "" || tag !== tag.trim().toLowerCase())) return false;
  if (new Set(tags).size !== tags.length) return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (value.due !== undefined) {
    if (typeof value.due !== "string") return false;
    try {
      parseDate(value.due, "stored due date");
    } catch {
      return false;
    }
  }
  if (value.status === "done") return isIsoTimestamp(value.completedAt);
  return value.completedAt === undefined;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value)) fail("database root must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => !["version", "nextId", "tasks"].includes(key))) {
    fail("database contains unknown fields");
  }
  if (value.version !== 1) fail("unsupported database version");
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) {
    fail("database has an invalid nextId");
  }
  if (!Array.isArray(value.tasks) || !value.tasks.every(validateTask)) {
    fail("database contains an invalid task");
  }
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) fail("database contains duplicate task ids");
  if (ids.some((id) => id >= (value.nextId as number))) {
    fail("database nextId must be greater than every task id");
  }
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let contents: string;
  try {
    contents = await readFile(databasePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    fail("database is not valid JSON");
  }
  return validateDatabase(parsed);
}

async function saveDatabase(database: Database): Promise<void> {
  await mkdir(dirname(databasePath), { recursive: true });
  const temporaryPath = `${databasePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a safe positive integer");
  return id;
}

function parseFlags(
  args: string[],
  allowed: ReadonlySet<string>,
): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag.startsWith("--")) fail(`unexpected argument: ${flag}`);
    if (!allowed.has(flag)) fail(`unknown flag: ${flag}`);
    if (flags.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function requireNoExtraArgs(args: string[]): void {
  if (args.length > 0) fail(`unexpected argument: ${args[0]}`);
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const rawTitle = flags.get("--title");
    if (rawTitle === undefined) fail("missing required flag: --title");
    const title = rawTitle.trim();
    if (!title) fail("title must not be empty");
    const due = flags.has("--due") ? parseDate(flags.get("--due")!, "due date") : undefined;
    const tags = flags.has("--tags") ? parseTags(flags.get("--tags")!) : [];
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      tags,
      ...(due === undefined ? {} : { due }),
      createdAt: new Date().toISOString(),
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
    const overdue = flags.has("--overdue")
      ? parseDate(flags.get("--overdue")!, "overdue date")
      : undefined;
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter(
        (task) =>
          overdue === undefined ||
          (task.status === "open" && task.due !== undefined && task.due < overdue),
      )
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("usage: done ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`task ${id} does not exist`);
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
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`task ${id} does not exist`);
    const [deleted] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return deleted;
  }

  if (command === "stats") {
    requireNoExtraArgs(rest);
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
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(`taskboard: ${message}`);
  process.exitCode = 1;
}
