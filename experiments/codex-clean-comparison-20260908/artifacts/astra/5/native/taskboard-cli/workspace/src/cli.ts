import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDatabase(value: unknown): asserts value is Database {
  const bad = () => fail("Malformed taskboard database");
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId)
    || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) bad();
  const db = value as Record<string, unknown>;
  const ids = new Set<number>();
  for (const task of db.tasks as unknown[]) {
    if (!isRecord(task)) bad();
    const t = task as Record<string, unknown>;
    if (!Number.isSafeInteger(t.id) || (t.id as number) < 1
      || (t.id as number) >= (db.nextId as number) || ids.has(t.id as number)
      || typeof t.title !== "string" || !t.title.trim()
      || (t.status !== "open" && t.status !== "done") || !validTimestamp(t.createdAt)
      || !Array.isArray(t.tags)
      || !t.tags.every(tag => typeof tag === "string" && tag !== "" && normalizeTag(tag) === tag)
      || new Set(t.tags).size !== t.tags.length
      || ("due" in t && !validDate(t.due))
      || (t.status === "done" ? !validTimestamp(t.completedAt) : "completedAt" in t)) bad();
    ids.add(t.id as number);
  }
}

function load(file: string): Database {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    throw error;
  }
  let db: unknown;
  try { db = JSON.parse(content); } catch { fail("Malformed taskboard database: invalid JSON"); }
  validateDatabase(db);
  return db;
}

function save(file: string, db: Database): void {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
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

function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.includes(key)) fail(`Unknown flag or argument: ${key}`);
    if (key in result) fail(`Repeated flag: ${key}`);
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) fail(`Missing value for ${key}`);
    result[key] = args[i + 1];
  }
  return result;
}

function today(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}

function main(args: string[]): unknown {
  const [command, ...rest] = args;
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  const file = process.env.TASKBOARD_FILE ?? ".taskboard.json";
  if (!file) fail("TASKBOARD_FILE must not be empty");
  const db = load(file);
  if (command === "add") {
    const opts = options(rest, ["--title", "--tags", "--due"]);
    const title = opts["--title"]?.trim();
    if (!title) fail("A non-empty --title is required");
    if ("--due" in opts && !validDate(opts["--due"])) fail("Invalid due date; expected YYYY-MM-DD");
    if (db.nextId >= Number.MAX_SAFE_INTEGER) fail("Task IDs exhausted");
    const task: Task = {
      id: db.nextId++, title, status: "open", createdAt: new Date().toISOString(),
      tags: [...new Set((opts["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))],
      ...("--due" in opts ? { due: opts["--due"] } : {}),
    };
    db.tasks.push(task);
    save(file, db);
    return task;
  }
  if (command === "list") {
    const opts = options(rest, ["--status", "--tag", "--overdue"]);
    if ("--status" in opts && !["open", "done"].includes(opts["--status"])) fail("Invalid status; expected open or done");
    if ("--overdue" in opts && !validDate(opts["--overdue"])) fail("Invalid overdue date; expected YYYY-MM-DD");
    if ("--tag" in opts && !normalizeTag(opts["--tag"])) fail("Tag must not be empty");
    return db.tasks.filter(task =>
      (!("--status" in opts) || task.status === opts["--status"])
      && (!("--tag" in opts) || task.tags.includes(normalizeTag(opts["--tag"])))
      && (!("--overdue" in opts) || overdue(task, opts["--overdue"])),
    ).sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    options(rest, []);
    const date = today();
    return {
      total: db.tasks.length,
      open: db.tasks.filter(task => task.status === "open").length,
      done: db.tasks.filter(task => task.status === "done").length,
      overdue: db.tasks.filter(task => overdue(task, date)).length,
    };
  }
  if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]) || !Number.isSafeInteger(Number(rest[0]))) fail(`${command} requires one positive integer ID`);
  const task = db.tasks.find(task => task.id === Number(rest[0]));
  if (!task) fail(`Task ${rest[0]} not found`);
  if (command === "delete") {
    db.tasks = db.tasks.filter(candidate => candidate.id !== task.id);
    save(file, db);
  } else if (task.status !== "done") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    save(file, db);
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
