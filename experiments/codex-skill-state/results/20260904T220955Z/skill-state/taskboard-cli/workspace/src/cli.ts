#!/usr/bin/env bun

type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  tags: string[];
  status: Status;
  createdAt: string;
  due?: string;
  completedAt?: string;
}

interface Database {
  tasks: Task[];
  nextId: number;
}

const filePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new Error(message);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function localToday(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function validateDatabase(value: unknown): Database {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Malformed database");
  const db = value as Partial<Database>;
  if (!Array.isArray(db.tasks) || !Number.isSafeInteger(db.nextId) || db.nextId! < 1) fail("Malformed database");
  const ids = new Set<number>();
  for (const task of db.tasks) {
    if (!task || typeof task !== "object" || !Number.isSafeInteger(task.id) || task.id < 1 || ids.has(task.id)) fail("Malformed database");
    ids.add(task.id);
    if (typeof task.title !== "string" || !task.title.trim() || !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== "string") || (task.status !== "open" && task.status !== "done") || typeof task.createdAt !== "string") fail("Malformed database");
    if (task.due !== undefined && (typeof task.due !== "string" || !isDate(task.due))) fail("Malformed database");
    if (task.completedAt !== undefined && typeof task.completedAt !== "string") fail("Malformed database");
    if (task.status === "done" && typeof task.completedAt !== "string") fail("Malformed database");
  }
  if (db.tasks.some(task => task.id >= db.nextId!)) fail("Malformed database");
  return db as Database;
}

async function load(): Promise<Database> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return { tasks: [], nextId: 1 };
  try {
    return validateDatabase(JSON.parse(await file.text()));
  } catch (error) {
    if (error instanceof Error && error.message === "Malformed database") throw error;
    fail("Malformed database");
  }
}

async function save(db: Database): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await Bun.write(tempPath, JSON.stringify(db, null, 2) + "\n");
    const result = Bun.spawnSync(["mv", "-f", tempPath, filePath]);
    if (result.exitCode !== 0) fail("Could not write database");
  } catch {
    try { Bun.spawnSync(["rm", "-f", tempPath]); } catch { /* best effort */ }
    fail("Could not write database");
  }
}

function parseOptions(args: string[], allowed: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!allowed.includes(flag) || value === undefined || !flag.startsWith("--") || options.has(flag)) fail(`Invalid option: ${flag}`);
    options.set(flag, value);
  }
  return options;
}

function taskId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) fail("Invalid task id");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail("Invalid task id");
  return id;
}

async function main(args: string[]): Promise<unknown> {
  const command = args[0];
  if (!command) fail("Missing command");
  const db = await load();

  if (command === "add") {
    const options = parseOptions(args.slice(1), ["--title", "--tags", "--due"]);
    const title = options.get("--title")?.trim();
    if (!title) fail("Title is required");
    const due = options.get("--due");
    if (due !== undefined && !isDate(due)) fail("Invalid due date");
    const tags = [...new Set((options.get("--tags") || "").split(",").map(tag => tag.trim().toLowerCase()).filter(Boolean))];
    const task: Task = { id: db.nextId++, title, tags, status: "open", createdAt: new Date().toISOString(), ...(due ? { due } : {}) };
    db.tasks.push(task);
    await save(db);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(args.slice(1), ["--status", "--tag", "--overdue"]);
    const status = options.get("--status");
    const tag = options.get("--tag")?.trim().toLowerCase();
    const overdue = options.get("--overdue");
    if (status !== undefined && status !== "open" && status !== "done") fail("Invalid status");
    if (overdue !== undefined && !isDate(overdue)) fail("Invalid overdue date");
    return db.tasks.filter(task =>
      (status === undefined || task.status === status) &&
      (!tag || task.tags.includes(tag)) &&
      (overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue)),
    ).sort((a, b) => a.id - b.id);
  }

  if (command === "done" || command === "delete") {
    if (args.length !== 2) fail(`Usage: ${command} ID`);
    const id = taskId(args[1]);
    const index = db.tasks.findIndex(task => task.id === id);
    if (index < 0) fail("Task not found");
    if (command === "delete") {
      db.tasks.splice(index, 1);
      await save(db);
      return { id, deleted: true };
    }
    const task = db.tasks[index];
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await save(db);
    }
    return task;
  }

  if (command === "stats") {
    if (args.length !== 1) fail("Invalid option");
    const open = db.tasks.filter(task => task.status === "open");
    return { total: db.tasks.length, open: open.length, done: db.tasks.length - open.length, overdue: open.filter(task => task.due && task.due < localToday()).length };
  }
  fail(`Unknown command: ${command}`);
}

try {
  console.log(JSON.stringify(await main(process.argv.slice(2))));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unexpected error");
  process.exitCode = 1;
}
