import { readFile, writeFile, rename, unlink } from "node:fs/promises";
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

function fail(message: string): never { throw new Error(message); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}
function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function normalizeTag(value: string): string { return value.trim().toLowerCase(); }
function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) ||
      (value.nextId as number) < 1 || !Array.isArray(value.tasks)) fail("Malformed database");
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!isRecord(task) || !Number.isSafeInteger(task.id) || (task.id as number) < 1 ||
        (task.id as number) >= (value.nextId as number) || ids.has(task.id as number) ||
        typeof task.title !== "string" || task.title.trim() === "" ||
        !["open", "done"].includes(task.status as string) || !validInstant(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string" || !tag || normalizeTag(tag) !== tag) ||
        new Set(task.tags).size !== task.tags.length ||
        ("due" in task && !validDate(task.due)) ||
        (task.status === "done" ? !validInstant(task.completedAt) : "completedAt" in task)) {
      fail("Malformed database");
    }
    ids.add(task.id as number);
  }
  return value as unknown as Database;
}
async function load(file: string): Promise<Database> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("Malformed database: invalid JSON"); }
  return validateDatabase(value);
}
async function save(file: string, database: Database): Promise<void> {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    await writeFile(temporary, JSON.stringify(database, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    created = true;
    await rename(temporary, file);
  } finally {
    if (created) await unlink(temporary).catch(error => {
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
    if (args[i + 1] === undefined || args[i + 1].startsWith("--")) fail(`Missing value for ${flag}`);
    result[flag] = args[i + 1];
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
async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  if (!["add", "list", "done", "delete", "stats"].includes(command)) fail(`Unknown command: ${command ?? "(missing)"}`);
  const file = resolve(process.env.TASKBOARD_FILE ?? ".taskboard.json");
  const database = await load(file);
  switch (command) {
    case "add": {
      const opts = options(args, ["--title", "--tags", "--due"]);
      const title = opts["--title"]?.trim();
      if (!title) fail("A non-empty --title is required");
      dateOption(opts["--due"], "--due");
      if (database.nextId >= Number.MAX_SAFE_INTEGER) fail("Task ID limit reached");
      const task: Task = {
        id: database.nextId++, title, status: "open", createdAt: new Date().toISOString(),
        tags: [...new Set((opts["--tags"] ?? "").split(",").map(normalizeTag).filter(Boolean))],
        ...(opts["--due"] !== undefined ? { due: opts["--due"] } : {}),
      };
      database.tasks.push(task);
      await save(file, database);
      return task;
    }
    case "list": {
      const opts = options(args, ["--status", "--tag", "--overdue"]);
      if (opts["--status"] !== undefined && !["open", "done"].includes(opts["--status"])) fail("Invalid status: expected open or done");
      dateOption(opts["--overdue"], "--overdue");
      return database.tasks.filter(task =>
        (opts["--status"] === undefined || task.status === opts["--status"]) &&
        (opts["--tag"] === undefined || task.tags.includes(normalizeTag(opts["--tag"]))) &&
        (opts["--overdue"] === undefined || overdue(task, opts["--overdue"]))
      ).sort((a, b) => a.id - b.id);
    }
    case "done":
    case "delete": {
      if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) fail(`Usage: ${command} ID (positive integer)`);
      const task = database.tasks.find(task => task.id === Number(args[0]));
      if (!task) fail(`Task ${args[0]} not found`);
      if (command === "delete") database.tasks = database.tasks.filter(item => item.id !== task.id);
      else if (task.status === "done") return task;
      else { task.status = "done"; task.completedAt = new Date().toISOString(); }
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
try { console.log(JSON.stringify(await main())); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
