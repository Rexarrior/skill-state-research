#!/usr/bin/env bun

import { dirname, basename, join } from "node:path";
import { rename } from "node:fs/promises";

type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  status: Status;
  createdAt: string;
  tags: string[];
  due?: string;
  completedAt?: string;
}

interface Database {
  nextId: number;
  tasks: Task[];
}

const databasePath = process.env.TASKBOARD_FILE || join(process.cwd(), ".taskboard.json");

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "")) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isValidDate(value.due)) return false;
  if (value.status === "done" && !isIsoTimestamp(value.completedAt)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  return true;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "nextId" && key !== "tasks")) {
    return fail("Malformed taskboard database");
  }
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    return fail("Malformed taskboard database");
  }
  if (!value.tasks.every(validateTask)) return fail("Malformed taskboard database");
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (value.nextId as number))) {
    return fail("Malformed taskboard database");
  }
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  const file = Bun.file(databasePath);
  if (!(await file.exists())) return { nextId: 1, tasks: [] };
  try {
    return validateDatabase(JSON.parse(await file.text()));
  } catch (error) {
    if (error instanceof Error && error.message === "Malformed taskboard database") throw error;
    return fail("Malformed taskboard database");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const suffix = `${process.pid}-${crypto.randomUUID()}`;
  const temporaryPath = join(dirname(databasePath), `.${basename(databasePath)}.${suffix}.tmp`);
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try { await Bun.file(temporaryPath).delete(); } catch {}
    throw error;
  }
}

function parseOptions(args: string[], definitions: Record<string, boolean>): Record<string, string | true> {
  const options: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag.startsWith("--") || !(flag in definitions)) fail(`Unknown flag: ${flag}`);
    if (flag in options) fail(`Duplicate flag: ${flag}`);
    if (definitions[flag]) {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
      options[flag] = value;
    } else {
      options[flag] = true;
    }
  }
  return options;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) return fail("ID must be a positive integer");
  return id;
}

function normalizeTags(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const tags = raw.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  return [...new Set(tags)];
}

function localDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("Missing command");

  if (command === "add") {
    const options = parseOptions(rest, { "--title": true, "--tags": true, "--due": true });
    const title = options["--title"];
    if (typeof title !== "string") fail("Missing required flag: --title");
    if (title.trim() === "") fail("Title must not be empty");
    const due = options["--due"];
    if (due !== undefined && (typeof due !== "string" || !isValidDate(due))) fail("Due date must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId++,
      title: title.trim(),
      status: "open",
      createdAt: new Date().toISOString(),
      tags: normalizeTags(options["--tags"] as string | undefined),
      ...(due === undefined ? {} : { due }),
    };
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(rest, { "--status": true, "--tag": true, "--overdue": true });
    const status = options["--status"];
    if (status !== undefined && status !== "open" && status !== "done") fail("Status must be open or done");
    const overdue = options["--overdue"];
    if (overdue !== undefined && (typeof overdue !== "string" || !isValidDate(overdue))) fail("Overdue date must be a valid YYYY-MM-DD date");
    const tag = options["--tag"];
    if (typeof tag === "string" && tag.trim() === "") fail("Tag must not be empty");
    const normalizedTag = typeof tag === "string" ? tag.trim().toLowerCase() : undefined;
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => normalizedTag === undefined || task.tags.includes(normalizedTag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("Usage: done ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`Task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("Usage: delete ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`Task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`Unknown flag: ${rest[0]}`);
    const database = await loadDatabase();
    const today = localDate();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length;
    return { total: database.tasks.length, open, done, overdue };
  }

  fail(`Unknown command: ${command}`);
}

try {
  const result = await run(Bun.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
