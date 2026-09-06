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

type Database = { tasks: Task[]; nextId: number };

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new Error(message);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function localDate(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function normalizeTags(raw: string): string[] {
  const tags = raw.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return [...new Set(tags)];
}

function validateTask(value: unknown): value is Task {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return Number.isInteger(task.id) && task.id > 0 && typeof task.title === "string" &&
    Array.isArray(task.tags) && task.tags.every((tag) => typeof tag === "string") &&
    (task.status === "open" || task.status === "done") && typeof task.createdAt === "string" &&
    (task.due === undefined || (typeof task.due === "string" && isDate(task.due))) &&
    (task.completedAt === undefined || typeof task.completedAt === "string");
}

async function load(): Promise<Database> {
  const file = Bun.file(databasePath);
  if (!(await file.exists())) return { tasks: [], nextId: 1 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    fail(`Malformed database: ${databasePath}`);
  }
  if (!parsed || typeof parsed !== "object") fail(`Malformed database: ${databasePath}`);
  const db = parsed as Record<string, unknown>;
  if (!Array.isArray(db.tasks) || !db.tasks.every(validateTask) || !Number.isInteger(db.nextId) || (db.nextId as number) < 1) {
    fail(`Malformed database: ${databasePath}`);
  }
  const ids = db.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (db.nextId as number))) fail(`Malformed database: ${databasePath}`);
  return { tasks: db.tasks as Task[], nextId: db.nextId as number };
}

async function save(db: Database): Promise<void> {
  const target = databasePath;
  const slash = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  const directory = slash >= 0 ? target.slice(0, slash + 1) : "";
  const filename = slash >= 0 ? target.slice(slash + 1) : target;
  const temp = `${directory}.${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temp, `${JSON.stringify(db, null, 2)}\n`);
  try {
    await Bun.write(temp, Bun.file(temp)); // Ensure Bun has completed the write before rename.
    await Bun.spawn(["mv", temp, target]).exited;
  } catch (error) {
    try { await Bun.spawn(["rm", "-f", temp]).exited; } catch { /* best effort */ }
    throw error;
  }
}

type Parsed = { command: string; positional: string[]; options: Map<string, string | true> };

function parse(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  if (!command) fail("Missing command");
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const name = value.slice(2);
    if (!name) fail("Invalid flag");
    if (options.has(name)) fail(`Duplicate flag: --${name}`);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) fail(`Missing value for --${name}`);
    options.set(name, next);
    index++;
  }
  return { command, positional, options };
}

function option(parsed: Parsed, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function assertShape(parsed: Parsed, allowed: string[], positions: number): void {
  for (const name of parsed.options.keys()) if (!allowed.includes(name)) fail(`Unknown flag: --${name}`);
  if (parsed.positional.length !== positions) fail("Invalid arguments");
}

function taskId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) fail("Invalid task id");
  return Number(value);
}

async function main(): Promise<unknown> {
  const parsed = parse(process.argv.slice(2));
  const db = await load();
  switch (parsed.command) {
    case "add": {
      assertShape(parsed, ["title", "tags", "due"], 0);
      const title = option(parsed, "title")?.trim();
      if (!title) fail("A non-empty --title is required");
      const due = option(parsed, "due");
      if (due !== undefined && !isDate(due)) fail("Invalid due date");
      const task: Task = { id: db.nextId++, title, tags: normalizeTags(option(parsed, "tags") || ""), status: "open", createdAt: new Date().toISOString() };
      if (due) task.due = due;
      db.tasks.push(task);
      await save(db);
      return task;
    }
    case "list": {
      assertShape(parsed, ["status", "tag", "overdue"], 0);
      const status = option(parsed, "status");
      const tag = option(parsed, "tag")?.trim().toLowerCase();
      const overdue = option(parsed, "overdue");
      if (status !== undefined && status !== "open" && status !== "done") fail("Invalid status");
      if (overdue !== undefined && !isDate(overdue)) fail("Invalid overdue date");
      return db.tasks.filter((task) =>
        (status === undefined || task.status === status) &&
        (!tag || task.tags.includes(tag)) &&
        (overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue)),
      ).sort((a, b) => a.id - b.id);
    }
    case "done": {
      assertShape(parsed, [], 1);
      const task = db.tasks.find((item) => item.id === taskId(parsed.positional[0]));
      if (!task) fail("Task not found");
      if (task.status === "open") { task.status = "done"; task.completedAt = new Date().toISOString(); await save(db); }
      return task;
    }
    case "delete": {
      assertShape(parsed, [], 1);
      const id = taskId(parsed.positional[0]);
      const index = db.tasks.findIndex((task) => task.id === id);
      if (index === -1) fail("Task not found");
      const [task] = db.tasks.splice(index, 1);
      await save(db);
      return task;
    }
    case "stats": {
      assertShape(parsed, [], 0);
      const today = localDate();
      const open = db.tasks.filter((task) => task.status === "open");
      return { total: db.tasks.length, open: open.length, done: db.tasks.length - open.length, overdue: open.filter((task) => task.due !== undefined && task.due < today).length };
    }
    default: fail(`Unknown command: ${parsed.command}`);
  }
}

main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
