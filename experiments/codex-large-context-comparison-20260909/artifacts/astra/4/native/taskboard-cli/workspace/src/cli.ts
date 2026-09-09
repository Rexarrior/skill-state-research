import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

type Task = {
  id: number;
  title: string;
  status: "open" | "done";
  createdAt: string;
  tags: string[];
  due?: string;
  completedAt?: string;
};
type Database = { version: 1; nextId: number; tasks: Task[] };

function fail(message: string): never {
  throw new Error(message);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function validateDatabase(value: unknown): asserts value is Database {
  if (!isObject(value) || value.version !== 1 ||
      !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 ||
      !Array.isArray(value.tasks)) fail("Malformed database");
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!isObject(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (value.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || !task.title.trim() ||
        (task.status !== "open" && task.status !== "done") || !isTimestamp(task.createdAt) ||
        !Array.isArray(task.tags) ||
        task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !isDate(task.due)) ||
        (task.status === "done" ? !isTimestamp(task.completedAt) : "completedAt" in task)) {
      fail("Malformed database");
    }
    ids.add(task.id as number);
  }
}

async function load(file: string): Promise<Database> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    throw error;
  }
  let database: unknown;
  try {
    database = JSON.parse(raw);
  } catch {
    fail("Malformed database: invalid JSON");
  }
  validateDatabase(database);
  return database;
}

async function save(file: string, database: Database): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(database, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!allowed.includes(flag)) fail(`Unknown flag or argument: ${flag}`);
    if (flag in result) fail(`Duplicate flag: ${flag}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    result[flag] = value;
  }
  return result;
}

function localToday(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function overdue(task: Task, day: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < day;
}

async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !["add", "list", "done", "delete", "stats"].includes(command)) {
    fail(`Unknown or missing command: ${command ?? "(none)"}`);
  }
  const file = process.env.TASKBOARD_FILE ?? ".taskboard.json";
  const database = await load(file);
  switch (command) {
    case "add": {
      const opts = options(args, ["--title", "--tags", "--due"]);
      const title = opts["--title"]?.trim();
      if (!title) fail("A non-empty --title is required");
      if ("--due" in opts && !isDate(opts["--due"])) fail("Invalid --due date; expected YYYY-MM-DD");
      if (database.nextId >= Number.MAX_SAFE_INTEGER) fail("Task ID capacity exhausted");
      const task: Task = {
        id: database.nextId++, title, status: "open", createdAt: new Date().toISOString(),
        tags: [...new Set((opts["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))],
        ...("--due" in opts ? { due: opts["--due"] } : {}),
      };
      database.tasks.push(task);
      await save(file, database);
      return task;
    }
    case "list": {
      const opts = options(args, ["--status", "--tag", "--overdue"]);
      if ("--status" in opts && !["open", "done"].includes(opts["--status"])) fail("Invalid --status; expected open or done");
      if ("--overdue" in opts && !isDate(opts["--overdue"])) fail("Invalid --overdue date; expected YYYY-MM-DD");
      const tag = "--tag" in opts ? normalizeTag(opts["--tag"]) : undefined;
      if (tag === "") fail("--tag must not be empty");
      return database.tasks.filter(task =>
        (!("--status" in opts) || task.status === opts["--status"]) &&
        (tag === undefined || task.tags.includes(tag)) &&
        (!("--overdue" in opts) || overdue(task, opts["--overdue"]))
      ).sort((a, b) => a.id - b.id);
    }
    case "done":
    case "delete": {
      if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) {
        fail(`${command} requires one positive integer ID`);
      }
      const index = database.tasks.findIndex(task => task.id === Number(args[0]));
      if (index === -1) fail(`Task ${args[0]} not found`);
      const task = database.tasks[index];
      if (command === "delete") database.tasks.splice(index, 1);
      else if (task.status === "done") return task;
      else {
        task.status = "done";
        task.completedAt = new Date().toISOString();
      }
      await save(file, database);
      return task;
    }
    case "stats": {
      options(args, []);
      const today = localToday();
      return {
        total: database.tasks.length,
        open: database.tasks.filter(task => task.status === "open").length,
        done: database.tasks.filter(task => task.status === "done").length,
        overdue: database.tasks.filter(task => overdue(task, today)).length,
      };
    }
  }
}

try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
