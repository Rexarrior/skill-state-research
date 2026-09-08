import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

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
type Command =
  | { name: "add"; title: string; tags: string[]; due?: string }
  | { name: "list"; status?: "open" | "done"; tag?: string; overdue?: string }
  | { name: "done" | "delete"; id: number }
  | { name: "stats" };

function fail(message: string): never {
  throw new Error(message);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function dateOption(value: string | undefined, flag: string): string | undefined {
  if (value !== undefined && !validDate(value)) fail(`${flag} requires a valid YYYY-MM-DD date`);
  return value;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parse(args: string[]): Command {
  const [name, ...rest] = args;
  if (name === "done" || name === "delete") {
    if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]) || !Number.isSafeInteger(Number(rest[0]))) {
      fail(`${name} requires one positive integer ID`);
    }
    return { name, id: Number(rest[0]) };
  }
  if (name === "stats") {
    if (rest.length) fail("stats accepts no arguments");
    return { name };
  }
  if (name !== "add" && name !== "list") fail(`Unknown command: ${name ?? "(missing)"}`);
  const allowed = name === "add" ? ["--title", "--tags", "--due"] : ["--status", "--tag", "--overdue"];
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (!allowed.includes(flag)) fail(`Unknown flag or argument: ${flag}`);
    if (options.has(flag)) fail(`Duplicate flag: ${flag}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    options.set(flag, value);
  }
  if (name === "add") {
    const title = options.get("--title")?.trim();
    if (!title) fail("--title requires a non-empty title");
    const tags = [...new Set((options.get("--tags") ?? "").split(",").map(normalizeTag).filter(Boolean))];
    return { name, title, tags, due: dateOption(options.get("--due"), "--due") };
  }
  const status = options.get("--status");
  if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
  const tag = options.get("--tag") === undefined ? undefined : normalizeTag(options.get("--tag")!);
  if (tag === "") fail("--tag requires a non-empty tag");
  return { name, status, tag, overdue: dateOption(options.get("--overdue"), "--overdue") };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validate(value: unknown): Database {
  const invalid = () => fail("Malformed taskboard database");
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) ||
      (value.nextId as number) < 1 || !Array.isArray(value.tasks)) return invalid();
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!record(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (value.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || task.title.trim() === "" ||
        (task.status !== "open" && task.status !== "done") || !timestamp(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !validDate(task.due)) ||
        (task.status === "done" ? !timestamp(task.completedAt) : "completedAt" in task)) return invalid();
    ids.add(task.id as number);
  }
  return value as Database;
}

async function load(path: string): Promise<Database> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(content); } catch { fail("Malformed taskboard database: invalid JSON"); }
  return validate(value);
}

async function save(path: string, database: Database): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(database, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}

async function main(): Promise<unknown> {
  const command = parse(process.argv.slice(2));
  const path = process.env.TASKBOARD_FILE ?? ".taskboard.json";
  if (!path) fail("TASKBOARD_FILE must not be empty");
  const database = await load(path);
  if (command.name === "list") {
    return database.tasks.filter(task =>
      (command.status === undefined || task.status === command.status) &&
      (command.tag === undefined || task.tags.includes(command.tag)) &&
      (command.overdue === undefined || overdue(task, command.overdue))
    ).sort((a, b) => a.id - b.id);
  }
  if (command.name === "stats") {
    const now = new Date();
    const today = `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const open = database.tasks.filter(task => task.status === "open").length;
    return { total: database.tasks.length, open, done: database.tasks.length - open,
      overdue: database.tasks.filter(task => overdue(task, today)).length };
  }
  let result: Task;
  if (command.name === "add") {
    if (database.nextId === Number.MAX_SAFE_INTEGER) fail("Task ID space exhausted");
    result = { id: database.nextId++, title: command.title, status: "open",
      createdAt: new Date().toISOString(), tags: command.tags };
    if (command.due !== undefined) result.due = command.due;
    database.tasks.push(result);
  } else {
    const index = database.tasks.findIndex(task => task.id === command.id);
    if (index === -1) fail(`Task ${command.id} not found`);
    result = database.tasks[index];
    if (command.name === "delete") database.tasks.splice(index, 1);
    else {
      if (result.status === "done") return result;
      result.status = "done";
      result.completedAt = new Date().toISOString();
    }
  }
  await save(path, database);
  return result;
}

try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
