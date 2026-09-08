import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";

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

function isObject(value: unknown): value is Record<string, unknown> {
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

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseTags(value: string): string[] {
  return [...new Set(value.split(",").map(normalizeTag).filter(Boolean))];
}

function validateDatabase(value: unknown): Database {
  if (!isObject(value)) fail("database must be a JSON object");
  if (value.version !== 1) fail("database has an unsupported version");
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) {
    fail("database has an invalid nextId");
  }
  if (!Array.isArray(value.tasks)) fail("database has an invalid tasks collection");

  const ids = new Set<number>();
  let greatestId = 0;
  for (const raw of value.tasks) {
    if (!isObject(raw)) fail("database contains an invalid task");
    if (!Number.isSafeInteger(raw.id) || (raw.id as number) < 1 || ids.has(raw.id as number)) {
      fail("database contains an invalid or duplicate task id");
    }
    ids.add(raw.id as number);
    greatestId = Math.max(greatestId, raw.id as number);
    if (typeof raw.title !== "string" || raw.title.trim() === "") {
      fail("database contains a task with an invalid title");
    }
    if (raw.status !== "open" && raw.status !== "done") {
      fail("database contains a task with an invalid status");
    }
    if (!Array.isArray(raw.tags) || raw.tags.some((tag) => typeof tag !== "string" || !tag)) {
      fail("database contains a task with invalid tags");
    }
    const normalizedTags = raw.tags.map((tag) => normalizeTag(tag as string));
    if (
      normalizedTags.some((tag) => !tag) ||
      new Set(normalizedTags).size !== normalizedTags.length ||
      normalizedTags.some((tag, index) => tag !== raw.tags[index])
    ) {
      fail("database contains non-normalized or duplicate tags");
    }
    if (raw.due !== undefined && (typeof raw.due !== "string" || parseDate(raw.due, "stored due date") !== raw.due)) {
      fail("database contains an invalid due date");
    }
    if (!isIsoTimestamp(raw.createdAt)) fail("database contains an invalid createdAt timestamp");
    if (raw.status === "done" && !isIsoTimestamp(raw.completedAt)) {
      fail("database contains a done task without a valid completedAt timestamp");
    }
    if (raw.status === "open" && raw.completedAt !== undefined) {
      fail("database contains an open task with completedAt");
    }
  }
  if ((value.nextId as number) <= greatestId) fail("database nextId does not exceed existing ids");
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await readFile(databasePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("database contains malformed JSON");
  }
  return validateDatabase(value);
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = join(
    directory,
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx");
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

function parseFlags(
  args: string[],
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string> = new Set(),
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
  for (const flag of required) {
    if (!flags.has(flag)) fail(`missing required flag: ${flag}`);
  }
  return flags;
}

function parseId(args: string[]): number {
  if (args.length !== 1) fail("command requires exactly one task ID");
  if (!/^[1-9]\d*$/.test(args[0])) fail("task ID must be a positive integer");
  const id = Number(args[0]);
  if (!Number.isSafeInteger(id)) fail("task ID is too large");
  return id;
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function execute(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]), new Set(["--title"]));
    const title = flags.get("--title")!.trim();
    if (!title) fail("title must not be empty");
    const dueValue = flags.get("--due");
    const due = dueValue === undefined ? undefined : parseDate(dueValue, "due date");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      tags: flags.has("--tags") ? parseTags(flags.get("--tags")!) : [],
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
    const tagValue = flags.get("--tag");
    const tag = tagValue === undefined ? undefined : normalizeTag(tagValue);
    if (tagValue !== undefined && !tag) fail("tag must not be empty");
    const overdueValue = flags.get("--overdue");
    const overdue = overdueValue === undefined ? undefined : parseDate(overdueValue, "overdue date");
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
    const id = parseId(rest);
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
    const id = parseId(rest);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`unknown flag or argument: ${rest[0]}`);
    const database = await loadDatabase();
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

  fail(`unknown command: ${command}`);
}

try {
  const result = await execute(process.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(`taskboard: ${message}`);
  process.exitCode = 1;
}
