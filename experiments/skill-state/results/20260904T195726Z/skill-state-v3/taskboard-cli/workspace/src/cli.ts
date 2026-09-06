import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Status = "open" | "done";

type Task = {
  id: number;
  title: string;
  status: Status;
  tags: string[];
  due?: string;
  createdAt: string;
  completedAt?: string;
};

type Database = {
  nextId: number;
  tasks: Task[];
};

const databasePath = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");

function fail(message: string): never {
  throw new Error(message);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function validateDatabase(value: unknown): Database {
  if (typeof value !== "object" || value === null) fail("Malformed taskboard database");
  const candidate = value as Partial<Database>;
  if (!Number.isSafeInteger(candidate.nextId) || (candidate.nextId as number) < 1 || !Array.isArray(candidate.tasks)) {
    fail("Malformed taskboard database");
  }

  const ids = new Set<number>();
  for (const task of candidate.tasks) {
    if (typeof task !== "object" || task === null) fail("Malformed taskboard database");
    const item = task as Partial<Task>;
    const tagsValid = Array.isArray(item.tags)
      && item.tags.every((tag) => typeof tag === "string" && tag.length > 0 && tag === normalizeTag(tag))
      && new Set(item.tags).size === item.tags.length;
    const completedValid = item.status === "done"
      ? isIsoTimestamp(item.completedAt)
      : item.completedAt === undefined;
    if (!Number.isSafeInteger(item.id) || (item.id as number) < 1 || ids.has(item.id as number)
      || typeof item.title !== "string" || item.title.trim().length === 0
      || (item.status !== "open" && item.status !== "done") || !tagsValid
      || (item.due !== undefined && !isDate(item.due)) || !isIsoTimestamp(item.createdAt)
      || !completedValid) {
      fail("Malformed taskboard database");
    }
    ids.add(item.id as number);
  }
  const maxId = candidate.tasks.reduce((max, task) => Math.max(max, task.id), 0);
  if ((candidate.nextId as number) <= maxId) fail("Malformed taskboard database");
  return candidate as Database;
}

async function loadDatabase(): Promise<Database> {
  let contents: string;
  try {
    contents = await readFile(databasePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }
  try {
    return validateDatabase(JSON.parse(contents));
  } catch (error) {
    if (error instanceof Error && error.message === "Malformed taskboard database") throw error;
    fail("Malformed taskboard database");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  await mkdir(dirname(databasePath), { recursive: true });
  const temporaryPath = `${databasePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseFlags(args: string[], allowed: Set<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !allowed.has(flag)) fail(`Unknown flag: ${flag ?? ""}`);
    if (flags.has(flag)) fail(`Duplicate flag: ${flag}`);
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
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

function localDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title")?.trim();
    if (!title) fail("--title is required and must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isDate(due)) fail("Due date must be a valid YYYY-MM-DD date");
    const tags = [...new Set((flags.get("--tags") ?? "").split(",").map(normalizeTag).filter(Boolean))];
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
    if (status !== undefined && status !== "open" && status !== "done") fail("Status must be open or done");
    const tag = flags.has("--tag") ? normalizeTag(flags.get("--tag") as string) : undefined;
    if (tag !== undefined && tag.length === 0) fail("Tag must not be empty");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail("Overdue date must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("Usage: done ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const task = database.tasks.find((item) => item.id === id);
    if (!task) fail(`Task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("Usage: delete ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((item) => item.id === id);
    if (index === -1) fail(`Task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail("Usage: stats");
    const database = await loadDatabase();
    const today = localDate();
    return {
      total: database.tasks.length,
      open: database.tasks.filter((task) => task.status === "open").length,
      done: database.tasks.filter((task) => task.status === "done").length,
      overdue: database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(command === undefined ? "A command is required" : `Unknown command: ${command}`);
}

try {
  const output = await run(process.argv.slice(2));
  console.log(JSON.stringify(output));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(message);
  process.exitCode = 1;
}
