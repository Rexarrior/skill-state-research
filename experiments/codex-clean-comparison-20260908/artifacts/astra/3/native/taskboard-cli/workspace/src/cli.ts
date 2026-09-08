import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function validateDatabase(value: unknown): Database {
  const bad = () => fail("Malformed database");
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) ||
      (value.nextId as number) < 1 || !Array.isArray(value.tasks)) return bad();
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!isRecord(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (value.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || !task.title.trim() ||
        (task.status !== "open" && task.status !== "done") || !validTimestamp(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" ||
          !tag || normalizeTag(tag) !== tag) || new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !validDate(task.due)) ||
        (task.status === "done" ? !validTimestamp(task.completedAt) : "completedAt" in task)) return bad();
    ids.add(task.id as number);
  }
  return value as unknown as Database;
}

function load(file: string): Database {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(contents); } catch { return fail("Malformed database: invalid JSON"); }
  return validateDatabase(value);
}

function save(file: string, database: Database): void {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    writeFileSync(temporary, JSON.stringify(database, null, 2) + "\n", { flag: "wx", mode: 0o600 });
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
    const flag = args[i]!;
    if (!allowed.includes(flag)) fail(`Unknown flag or argument: ${flag}`);
    if (flag in result) fail(`Repeated flag: ${flag}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    result[flag] = value;
  }
  return result;
}

function dateOption(value: string | undefined, flag: string): void {
  if (value !== undefined && !validDate(value)) fail(`Invalid date for ${flag}: expected YYYY-MM-DD`);
}

function localToday(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}

function main(args: string[]): unknown {
  const [command, ...rest] = args;
  if (!command || !["add", "list", "done", "delete", "stats"].includes(command)) {
    fail(`Unknown command: ${command ?? "(missing)"}`);
  }
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  if (process.env.TASKBOARD_FILE === "") fail("TASKBOARD_FILE must not be empty");
  const database = load(file);
  if (command === "add") {
    const opts = options(rest, ["--title", "--tags", "--due"]);
    const title = opts["--title"]?.trim();
    if (!title) fail("A non-empty --title is required");
    dateOption(opts["--due"], "--due");
    if (database.nextId === Number.MAX_SAFE_INTEGER) fail("Task IDs exhausted");
    const task: Task = {
      id: database.nextId++, title, status: "open", createdAt: new Date().toISOString(),
      tags: [...new Set((opts["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))],
    };
    if (opts["--due"] !== undefined) task.due = opts["--due"];
    database.tasks.push(task);
    save(file, database);
    return task;
  }
  if (command === "list") {
    const opts = options(rest, ["--status", "--tag", "--overdue"]);
    if (opts["--status"] !== undefined && !["open", "done"].includes(opts["--status"])) fail("Invalid status");
    dateOption(opts["--overdue"], "--overdue");
    const tag = opts["--tag"] === undefined ? undefined : normalizeTag(opts["--tag"]);
    if (tag === "") fail("Tag must not be empty");
    return database.tasks.filter(task =>
      (opts["--status"] === undefined || task.status === opts["--status"]) &&
      (tag === undefined || task.tags.includes(tag)) &&
      (opts["--overdue"] === undefined || overdue(task, opts["--overdue"]))
    ).sort((a, b) => a.id - b.id);
  }
  if (command === "stats") {
    options(rest, []);
    const today = localToday();
    const done = database.tasks.filter(task => task.status === "done").length;
    return { total: database.tasks.length, open: database.tasks.length - done, done,
      overdue: database.tasks.filter(task => overdue(task, today)).length };
  }
  if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]!) || !Number.isSafeInteger(Number(rest[0]))) {
    fail(`${command} requires one positive integer ID`);
  }
  const index = database.tasks.findIndex(task => task.id === Number(rest[0]));
  if (index === -1) fail(`Task not found: ${rest[0]}`);
  const task = database.tasks[index]!;
  if (command === "delete") database.tasks.splice(index, 1);
  else {
    if (task.status === "done") return task;
    task.status = "done";
    task.completedAt = new Date().toISOString();
  }
  save(file, database);
  return task;
}

try {
  console.log(JSON.stringify(main(process.argv.slice(2))));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.log("null");
  process.exitCode = 1;
}
