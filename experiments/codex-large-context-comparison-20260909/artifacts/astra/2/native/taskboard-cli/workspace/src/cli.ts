import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

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
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function validate(value: unknown): Database {
  const bad = () => fail("Malformed taskboard database");
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) ||
      (value.nextId as number) < 1 || !Array.isArray(value.tasks)) return bad();
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!record(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (value.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || !task.title.trim() ||
        (task.status !== "open" && task.status !== "done") ||
        !validTimestamp(task.createdAt) || !Array.isArray(task.tags) ||
        !task.tags.every(tag => typeof tag === "string" && tag !== "" && normalizeTag(tag) === tag) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !validDate(task.due)) ||
        (task.status === "done" ? !validTimestamp(task.completedAt) : "completedAt" in task)) return bad();
    ids.add(task.id as number);
  }
  return value as Database;
}

function load(file: string): Database {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail("Malformed taskboard database: invalid JSON"); }
  return validate(value);
}

function save(file: string, db: Database): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(db, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!allowed.includes(flag)) fail(`Unknown flag or argument: ${flag}`);
    if (flag in result) fail(`Duplicate flag: ${flag}`);
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) fail(`Missing value for ${flag}`);
    result[flag] = args[i + 1];
  }
  return result;
}

function dateOption(value: string | undefined, flag: string): void {
  if (value !== undefined && !validDate(value)) fail(`Invalid date for ${flag}: expected a real YYYY-MM-DD date`);
}

function today(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}

function main(): unknown {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const db = load(file);
  switch (command) {
    case "add": {
      const opts = options(args, ["--title", "--tags", "--due"]);
      const title = opts["--title"]?.trim();
      if (!title) fail("A non-empty --title is required");
      dateOption(opts["--due"], "--due");
      if (db.nextId >= Number.MAX_SAFE_INTEGER) fail("Task ID limit reached");
      const task: Task = {
        id: db.nextId++, title, status: "open", createdAt: new Date().toISOString(),
        tags: [...new Set((opts["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))],
        ...(opts["--due"] !== undefined ? { due: opts["--due"] } : {}),
      };
      db.tasks.push(task);
      save(file, db);
      return task;
    }
    case "list": {
      const opts = options(args, ["--status", "--tag", "--overdue"]);
      if (opts["--status"] !== undefined && !["open", "done"].includes(opts["--status"])) fail("Invalid status: expected open or done");
      dateOption(opts["--overdue"], "--overdue");
      const tag = opts["--tag"] === undefined ? undefined : normalizeTag(opts["--tag"]);
      if (tag === "") fail("--tag must not be empty");
      return db.tasks.filter(task =>
        (opts["--status"] === undefined || task.status === opts["--status"]) &&
        (tag === undefined || task.tags.includes(tag)) &&
        (opts["--overdue"] === undefined || overdue(task, opts["--overdue"]))
      ).sort((a, b) => a.id - b.id);
    }
    case "done":
    case "delete": {
      if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) fail(`${command} requires one positive integer ID`);
      const index = db.tasks.findIndex(task => task.id === Number(args[0]));
      if (index === -1) fail(`Task ${args[0]} not found`);
      const task = db.tasks[index];
      if (command === "delete") db.tasks.splice(index, 1);
      else if (task.status === "done") return task;
      else { task.status = "done"; task.completedAt = new Date().toISOString(); }
      save(file, db);
      return task;
    }
    case "stats": {
      if (args.length) fail(`Unexpected argument: ${args[0]}`);
      const date = today();
      const done = db.tasks.filter(task => task.status === "done").length;
      return { total: db.tasks.length, open: db.tasks.length - done, done, overdue: db.tasks.filter(task => overdue(task, date)).length };
    }
  }
}

try {
  console.log(JSON.stringify(main()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
