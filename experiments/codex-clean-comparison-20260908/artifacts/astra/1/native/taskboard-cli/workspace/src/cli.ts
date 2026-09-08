import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
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
type Command = { name: string; options: Record<string, string>; id?: number };

function fail(message: string): never {
  throw new Error(message);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function parse(args: string[]): Command {
  const [name, ...rest] = args;
  const flags: Record<string, string[]> = {
    add: ["title", "tags", "due"],
    list: ["status", "tag", "overdue"],
    done: [],
    delete: [],
    stats: [],
  };
  if (!name || !Object.hasOwn(flags, name)) fail(`Unknown command: ${name ?? "(missing)"}`);
  if (name === "done" || name === "delete") {
    if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]) || !Number.isSafeInteger(Number(rest[0]))) {
      fail(`${name} requires one positive integer ID`);
    }
    return { name, options: {}, id: Number(rest[0]) };
  }
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const key = flag.slice(2);
    if (!flag.startsWith("--") || !flags[name].includes(key)) fail(`Unknown flag or argument: ${flag}`);
    if (Object.hasOwn(options, key)) fail(`Duplicate flag: ${flag}`);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    options[key] = value;
  }
  if (name === "add" && !options.title?.trim()) fail("--title must be non-empty");
  if (options.status !== undefined && !["open", "done"].includes(options.status)) fail("--status must be open or done");
  if (options.tag !== undefined && !normalizeTag(options.tag)) fail("--tag must be non-empty");
  for (const key of ["due", "overdue"]) {
    if (options[key] !== undefined && !isDate(options[key])) fail(`--${key} must be a valid YYYY-MM-DD date`);
  }
  return { name, options };
}

function validateDatabase(value: unknown): asserts value is Database {
  const invalid = () => fail("Malformed database: invalid schema");
  if (!isObject(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) ||
      (value.nextId as number) < 1 || !Array.isArray(value.tasks)) invalid();
  const db = value as Record<string, unknown>;
  const ids = new Set<number>();
  for (const task of db.tasks as unknown[]) {
    if (!isObject(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (db.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || !task.title.trim() ||
        (task.status !== "open" && task.status !== "done") || !isTimestamp(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !isDate(task.due)) ||
        (task.status === "done" ? !isTimestamp(task.completedAt) : "completedAt" in task)) invalid();
    ids.add((task as Task).id);
  }
}

function readDatabase(file: string): Database {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    fail("Malformed database: invalid JSON");
  }
  validateDatabase(value);
  return value;
}

function writeDatabase(file: string, db: Database): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    writeFileSync(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    created = true;
    renameSync(temporary, file);
  } finally {
    if (created) {
      try { unlinkSync(temporary); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}

function run(): unknown {
  const { name, options, id } = parse(process.argv.slice(2));
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = readDatabase(file);
  if (name === "list") {
    return db.tasks.filter(task =>
      (options.status === undefined || task.status === options.status) &&
      (options.tag === undefined || task.tags.includes(normalizeTag(options.tag))) &&
      (options.overdue === undefined || overdue(task, options.overdue))
    ).sort((a, b) => a.id - b.id);
  }
  if (name === "stats") {
    const now = new Date();
    const today = `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const done = db.tasks.filter(task => task.status === "done").length;
    return { total: db.tasks.length, open: db.tasks.length - done, done, overdue: db.tasks.filter(task => overdue(task, today)).length };
  }
  let result: Task;
  if (name === "add") {
    if (db.nextId >= Number.MAX_SAFE_INTEGER) fail("Task ID range exhausted");
    result = {
      id: db.nextId++, title: options.title.trim(), status: "open",
      createdAt: new Date().toISOString(),
      tags: [...new Set((options.tags ?? "").split(",").map(normalizeTag).filter(Boolean))],
      ...(options.due === undefined ? {} : { due: options.due }),
    };
    db.tasks.push(result);
  } else {
    const index = db.tasks.findIndex(task => task.id === id);
    if (index === -1) fail(`Task ${id} does not exist`);
    result = db.tasks[index];
    if (name === "delete") db.tasks.splice(index, 1);
    else {
      if (result.status === "done") return result;
      result.status = "done";
      result.completedAt = new Date().toISOString();
    }
  }
  writeDatabase(file, db);
  return result;
}

try {
  process.stdout.write(JSON.stringify(run()) + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`taskboard: ${message}\n`);
  process.stdout.write(JSON.stringify({ error: message }) + "\n");
  process.exitCode = 1;
}
