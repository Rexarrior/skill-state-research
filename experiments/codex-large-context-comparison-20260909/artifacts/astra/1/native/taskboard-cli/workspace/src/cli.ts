import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function validateDatabase(value: unknown): asserts value is Database {
  const invalid = () => fail("Malformed taskboard database");
  if (!isObject(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) ||
      (value.nextId as number) < 1 || !Array.isArray(value.tasks)) invalid();
  const db = value as Record<string, unknown>;
  const ids = new Set<number>();
  for (const candidate of db.tasks as unknown[]) {
    if (!isObject(candidate)) invalid();
    const task = candidate as Record<string, unknown>;
    if (!Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (db.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || task.title.trim().length === 0 ||
        (task.status !== "open" && task.status !== "done") || !isTimestamp(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(tag =>
          typeof tag !== "string" || !tag || normalizeTag(tag) !== tag) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !isDate(task.due)) ||
        (task.status === "done" ? !isTimestamp(task.completedAt) : "completedAt" in task)) invalid();
    ids.add(task.id as number);
  }
}

function load(path: string): Database {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(content); } catch { fail("Malformed taskboard database: invalid JSON"); }
  validateDatabase(value);
  return value;
}

function save(path: string, db: Database): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!allowed.includes(flag)) fail(`Unknown flag or argument: ${flag}`);
    if (flag in result) fail(`Duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    result[flag] = value;
  }
  return result;
}

function dateOption(value: string | undefined, flag: string): void {
  if (value !== undefined && !isDate(value)) fail(`Invalid ${flag}: expected a real YYYY-MM-DD date`);
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear().toString().padStart(4, "0")}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
}

function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}

function main(args: string[]): unknown {
  const [command, ...rest] = args;
  if (!["add", "list", "done", "delete", "stats"].includes(command)) {
    fail(`Unknown or missing command: ${command ?? "(none)"}`);
  }
  const path = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = load(path);
  if (command === "add") {
    const opts = options(rest, ["--title", "--tags", "--due"]);
    const title = opts["--title"]?.trim();
    if (!title) fail("A non-empty --title is required");
    dateOption(opts["--due"], "--due");
    if (db.nextId >= Number.MAX_SAFE_INTEGER) fail("Task IDs exhausted");
    const task: Task = {
      id: db.nextId++, title, status: "open", createdAt: new Date().toISOString(),
      tags: [...new Set((opts["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))],
      ...(opts["--due"] !== undefined ? { due: opts["--due"] } : {}),
    };
    db.tasks.push(task);
    save(path, db);
    return task;
  }
  if (command === "list") {
    const opts = options(rest, ["--status", "--tag", "--overdue"]);
    if (opts["--status"] !== undefined && !["open", "done"].includes(opts["--status"])) {
      fail("Invalid --status: expected open or done");
    }
    dateOption(opts["--overdue"], "--overdue");
    const tag = opts["--tag"] === undefined ? undefined : normalizeTag(opts["--tag"]);
    if (tag === "") fail("A non-empty --tag is required");
    return db.tasks.filter(task =>
      (opts["--status"] === undefined || task.status === opts["--status"]) &&
      (tag === undefined || task.tags.includes(tag)) &&
      (opts["--overdue"] === undefined || overdue(task, opts["--overdue"]))
    ).sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    if (rest.length) fail(`Unexpected argument: ${rest[0]}`);
    const today = localToday();
    return {
      total: db.tasks.length,
      open: db.tasks.filter(task => task.status === "open").length,
      done: db.tasks.filter(task => task.status === "done").length,
      overdue: db.tasks.filter(task => overdue(task, today)).length,
    };
  }
  if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]) || !Number.isSafeInteger(Number(rest[0]))) {
    fail(`${command} requires one positive integer ID`);
  }
  const task = db.tasks.find(task => task.id === Number(rest[0]));
  if (!task) fail(`Task ${rest[0]} not found`);
  if (command === "delete") {
    db.tasks = db.tasks.filter(candidate => candidate.id !== task.id);
    save(path, db);
  } else if (task.status !== "done") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    save(path, db);
  }
  return task;
}

try {
  console.log(JSON.stringify(main(process.argv.slice(2))));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
