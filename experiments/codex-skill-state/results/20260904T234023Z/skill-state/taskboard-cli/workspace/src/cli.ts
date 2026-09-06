#!/usr/bin/env bun

type Status = "open" | "done";

type Task = {
  id: number;
  title: string;
  tags: string[];
  status: Status;
  createdAt: string;
  due?: string;
  completedAt?: string;
};

type Database = { tasks: Task[] };

class CliError extends Error {}

const databasePath = process.env.TASKBOARD_FILE || `${process.cwd()}/.taskboard.json`;

function fail(message: string): never {
  throw new CliError(message);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function todayLocal(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function validateTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  if (!Number.isSafeInteger(task.id) || (task.id as number) < 1 || typeof task.title !== "string") return false;
  if (!Array.isArray(task.tags) || !task.tags.every((tag) => typeof tag === "string")) return false;
  if (task.status !== "open" && task.status !== "done") return false;
  if (typeof task.createdAt !== "string") return false;
  if (task.due !== undefined && (typeof task.due !== "string" || !isDate(task.due))) return false;
  if (task.completedAt !== undefined && typeof task.completedAt !== "string") return false;
  return true;
}

async function readDatabase(): Promise<Database> {
  const file = Bun.file(databasePath);
  if (!(await file.exists())) return { tasks: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    fail(`Malformed database: ${databasePath}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).tasks) || !(parsed as Record<string, unknown>).tasks.every(validateTask)) {
    fail(`Malformed database: ${databasePath}`);
  }
  const tasks = (parsed as Database).tasks;
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) fail(`Malformed database: ${databasePath}`);
  return { tasks };
}

async function writeDatabase(database: Database): Promise<void> {
  const temporary = `${databasePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await Bun.write(temporary, `${JSON.stringify(database, null, 2)}\n`);
    await Bun.spawn(["mv", temporary, databasePath]).exited;
  } catch (error) {
    try { await Bun.spawn(["rm", "-f", temporary]).exited; } catch { /* best effort */ }
    throw error;
  }
}

function parseOptions(args: string[], allowed: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (!flag.startsWith("--") || !allowed.includes(flag)) fail(`Unknown command or flag: ${flag}`);
    if (options.has(flag)) fail(`Duplicate flag: ${flag}`);
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    options.set(flag, value);
  }
  return options;
}

function normalizedTags(raw: string): string[] {
  const tags = raw.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return [...new Set(tags)];
}

function taskId(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) fail("ID must be a positive integer");
  return Number(raw);
}

async function run(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) fail("Missing command");
  const db = await readDatabase();

  switch (command) {
    case "add": {
      const options = parseOptions(args, ["--title", "--tags", "--due"]);
      const title = options.get("--title")?.trim();
      if (!title) fail("Title must not be empty");
      const due = options.get("--due");
      if (due !== undefined && !isDate(due)) fail("Due date must be a valid YYYY-MM-DD date");
      const id = db.tasks.reduce((highest, task) => Math.max(highest, task.id), 0) + 1;
      const task: Task = { id, title, tags: normalizedTags(options.get("--tags") ?? ""), status: "open", createdAt: new Date().toISOString(), ...(due === undefined ? {} : { due }) };
      db.tasks.push(task);
      await writeDatabase(db);
      return task;
    }
    case "list": {
      const options = parseOptions(args, ["--status", "--tag", "--overdue"]);
      const status = options.get("--status");
      if (status !== undefined && status !== "open" && status !== "done") fail("Status must be open or done");
      const overdue = options.get("--overdue");
      if (overdue !== undefined && !isDate(overdue)) fail("Overdue date must be a valid YYYY-MM-DD date");
      const tag = options.get("--tag")?.trim().toLowerCase();
      return db.tasks.filter((task) =>
        (status === undefined || task.status === status) &&
        (!tag || task.tags.includes(tag)) &&
        (overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue)),
      ).sort((a, b) => a.id - b.id);
    }
    case "done": {
      if (args.length !== 1) fail("Usage: done ID");
      const task = db.tasks.find((candidate) => candidate.id === taskId(args[0]));
      if (!task) fail("Task not found");
      if (task.status === "open") {
        task.status = "done";
        task.completedAt = new Date().toISOString();
        await writeDatabase(db);
      }
      return task;
    }
    case "delete": {
      if (args.length !== 1) fail("Usage: delete ID");
      const id = taskId(args[0]);
      const index = db.tasks.findIndex((task) => task.id === id);
      if (index === -1) fail("Task not found");
      const [deleted] = db.tasks.splice(index, 1);
      await writeDatabase(db);
      return deleted;
    }
    case "stats": {
      if (args.length !== 0) fail("Usage: stats");
      const today = todayLocal();
      const open = db.tasks.filter((task) => task.status === "open");
      return { total: db.tasks.length, open: open.length, done: db.tasks.length - open.length, overdue: open.filter((task) => task.due !== undefined && task.due < today).length };
    }
    default:
      fail(`Unknown command or flag: ${command}`);
  }
}

try {
  console.log(JSON.stringify(await run()));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unexpected error");
  process.exitCode = 1;
}
