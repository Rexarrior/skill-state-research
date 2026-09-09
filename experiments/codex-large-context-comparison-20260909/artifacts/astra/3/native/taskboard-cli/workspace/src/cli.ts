import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";

type Task = {
  id: number;
  title: string;
  status: "open" | "done";
  createdAt: string;
  tags: string[];
  due?: string;
  completedAt?: string;
};
type Database = { nextId: number; tasks: Task[] };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function validateDatabase(value: unknown): asserts value is Database {
  const bad = "Malformed database";
  assert(record(value), bad);
  assert(Number.isSafeInteger(value.nextId) && (value.nextId as number) > 0, bad);
  assert(Array.isArray(value.tasks), bad);
  const ids = new Set<number>();
  for (const task of value.tasks) {
    assert(record(task), bad);
    assert(Number.isSafeInteger(task.id) && (task.id as number) > 0, bad);
    const id = task.id as number;
    assert(!ids.has(id) && id < (value.nextId as number), bad);
    ids.add(id);
    assert(typeof task.title === "string" && task.title.trim().length > 0, bad);
    assert(task.status === "open" || task.status === "done", bad);
    assert(validTimestamp(task.createdAt), bad);
    assert(Array.isArray(task.tags), bad);
    assert(task.tags.every(tag => typeof tag === "string" && tag.length > 0 && normalizeTag(tag) === tag), bad);
    assert(new Set(task.tags).size === task.tags.length, bad);
    assert(!("due" in task) || validDate(task.due), bad);
    assert(task.status === "done" ? validTimestamp(task.completedAt) : !("completedAt" in task), bad);
  }
}

async function load(file: string): Promise<Database> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }
  let db: unknown;
  try {
    db = JSON.parse(content);
  } catch {
    throw new Error("Malformed database: invalid JSON");
  }
  validateDatabase(db);
  return db;
}

async function save(file: string, db: Database): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    await writeFile(temporary, `${JSON.stringify(db, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    created = true;
    await rename(temporary, file);
  } finally {
    if (created) await unlink(temporary).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function options(args: string[], allowed: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    assert(allowed.includes(flag), `Unknown flag or argument: ${flag}`);
    assert(!result.has(flag), `Duplicate flag: ${flag}`);
    const value = args[i + 1];
    assert(value !== undefined && !value.startsWith("--"), `Missing value for ${flag}`);
    result.set(flag, value);
  }
  return result;
}

function localToday(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function overdue(task: Task, date: string): boolean {
  return task.status === "open" && task.due !== undefined && task.due < date;
}

async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  assert(command && ["add", "list", "done", "delete", "stats"].includes(command), "Expected command: add, list, done, delete, stats");
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  // Validate all arguments before reading or modifying persistent data.
  const opts = options(command === "done" || command === "delete" ? [] : args,
    command === "add" ? ["--title", "--tags", "--due"] : command === "list" ? ["--status", "--tag", "--overdue"] : []);
  let id: number | undefined;
  if (command === "done" || command === "delete") {
    assert(args.length === 1 && /^[1-9]\d*$/.test(args[0]!), "Expected one positive integer task ID");
    id = Number(args[0]);
    assert(Number.isSafeInteger(id), "Invalid task ID");
  }
  if (command === "add") {
    assert((opts.get("--title") ?? "").trim().length > 0, "A nonempty --title is required");
    assert(!opts.has("--due") || validDate(opts.get("--due")), "Invalid due date: expected YYYY-MM-DD");
  }
  if (command === "list") {
    assert(!opts.has("--status") || ["open", "done"].includes(opts.get("--status")!), "Invalid status: expected open or done");
    assert(!opts.has("--overdue") || validDate(opts.get("--overdue")), "Invalid overdue date: expected YYYY-MM-DD");
    assert(!opts.has("--tag") || normalizeTag(opts.get("--tag")!).length > 0, "Tag must not be empty");
  }
  const db = await load(file);
  switch (command) {
    case "add": {
      assert(db.nextId < Number.MAX_SAFE_INTEGER, "Task ID space exhausted");
      const task: Task = {
        id: db.nextId++, title: opts.get("--title")!.trim(), status: "open",
        createdAt: new Date().toISOString(),
        tags: [...new Set((opts.get("--tags") ?? "").split(",").map(normalizeTag).filter(Boolean))],
      };
      if (opts.has("--due")) task.due = opts.get("--due")!;
      db.tasks.push(task);
      await save(file, db);
      return task;
    }
    case "list":
      return db.tasks.filter(task =>
        (!opts.has("--status") || task.status === opts.get("--status")) &&
        (!opts.has("--tag") || task.tags.includes(normalizeTag(opts.get("--tag")!))) &&
        (!opts.has("--overdue") || overdue(task, opts.get("--overdue")!))
      ).sort((a, b) => a.id - b.id);
    case "done":
    case "delete": {
      const task = db.tasks.find(task => task.id === id);
      assert(task, `Task ${id} not found`);
      if (command === "delete") db.tasks = db.tasks.filter(task => task.id !== id);
      else if (task.status === "done") return task;
      else {
        task.status = "done";
        task.completedAt = new Date().toISOString();
      }
      await save(file, db);
      return task;
    }
    case "stats": {
      const today = localToday();
      return {
        total: db.tasks.length,
        open: db.tasks.filter(task => task.status === "open").length,
        done: db.tasks.filter(task => task.status === "done").length,
        overdue: db.tasks.filter(task => overdue(task, today)).length,
      };
    }
  }
}

try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.log("null");
  process.exitCode = 1;
}
