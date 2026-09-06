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
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function assertTask(value: unknown, index: number): asserts value is Task {
  if (!isRecord(value)) fail(`Malformed database: task ${index} is not an object`);
  const allowed = new Set(["id", "title", "status", "tags", "due", "createdAt", "completedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail(`Malformed database: task ${index} has unknown fields`);
  }
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) {
    fail(`Malformed database: task ${index} has an invalid id`);
  }
  if (typeof value.title !== "string" || value.title.trim() === "") {
    fail(`Malformed database: task ${index} has an invalid title`);
  }
  if (value.status !== "open" && value.status !== "done") {
    fail(`Malformed database: task ${index} has an invalid status`);
  }
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) {
    fail(`Malformed database: task ${index} has invalid tags`);
  }
  if (value.due !== undefined && !isDate(value.due)) {
    fail(`Malformed database: task ${index} has an invalid due date`);
  }
  if (!isIsoTimestamp(value.createdAt)) {
    fail(`Malformed database: task ${index} has an invalid createdAt`);
  }
  if (value.status === "done" && !isIsoTimestamp(value.completedAt)) {
    fail(`Malformed database: task ${index} is done without completedAt`);
  }
  if (value.status === "open" && value.completedAt !== undefined) {
    fail(`Malformed database: open task ${index} has completedAt`);
  }
}

function parseDatabase(text: string): Database {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail("Malformed database: invalid JSON");
  }
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) ||
      (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("Malformed database: invalid document structure");
  }
  const allowed = new Set(["version", "nextId", "tasks"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail("Malformed database: unknown document fields");
  }
  value.tasks.forEach(assertTask);
  const ids = new Set(value.tasks.map((task) => task.id));
  if (ids.size !== value.tasks.length) fail("Malformed database: duplicate task ids");
  const maxId = value.tasks.reduce((max, task) => Math.max(max, task.id), 0);
  if ((value.nextId as number) <= maxId) fail("Malformed database: nextId is not greater than task ids");
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  try {
    return parseDatabase(await readFile(databasePath, "utf8"));
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${databasePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseFlags(args: string[], definitions: Record<string, boolean>): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag.startsWith("--") || !(flag in definitions)) fail(`Unknown flag or argument: ${flag}`);
    if (flag in result) fail(`Flag specified more than once: ${flag}`);
    if (!definitions[flag]) fail(`Unsupported flag: ${flag}`);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    result[flag] = value;
  }
  return result;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a safe positive integer");
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
  const [command, ...rest] = args;
  if (!command) fail("Missing command");

  if (command === "add") {
    const flags = parseFlags(rest, { "--title": true, "--tags": true, "--due": true });
    const title = flags["--title"];
    if (title === undefined) fail("Missing required flag: --title");
    if (title.trim() === "") fail("Title must not be empty");
    const due = flags["--due"];
    if (due !== undefined && !isDate(due)) fail("Due date must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title: title.trim(),
      status: "open",
      tags: normalizeTags(flags["--tags"]),
      ...(due === undefined ? {} : { due }),
      createdAt: new Date().toISOString(),
    };
    database.nextId++;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const flags = parseFlags(rest, { "--status": true, "--tag": true, "--overdue": true });
    const status = flags["--status"];
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("Status must be open or done");
    }
    const overdue = flags["--overdue"];
    if (overdue !== undefined && !isDate(overdue)) fail("Overdue date must be a valid YYYY-MM-DD date");
    const tag = flags["--tag"]?.trim().toLowerCase();
    if (flags["--tag"] !== undefined && !tag) fail("Tag must not be empty");
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
    const task = database.tasks.find((candidate) => candidate.id === id);
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
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index === -1) fail(`Task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`Unknown flag or argument: ${rest[0]}`);
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

  fail(`Unknown command: ${command}`);
}

try {
  const result = await execute(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.stderr.write(`taskboard: ${message}\n`);
  process.exitCode = 1;
}
