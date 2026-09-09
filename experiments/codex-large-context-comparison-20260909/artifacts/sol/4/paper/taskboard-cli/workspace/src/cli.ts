#!/usr/bin/env bun

import { rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

type Status = "open" | "done";

interface Task {
  id: number;
  title: string;
  status: Status;
  tags: string[];
  due?: string;
  createdAt: string;
  completedAt?: string;
}

interface Database {
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const databasePath = process.env.TASKBOARD_FILE || ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const allowed = new Set(["id", "title", "status", "tags", "due", "createdAt", "completedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string" && tag !== "")) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.tags.some((tag) => tag !== normalizeTag(tag))) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && value.completedAt === undefined) return false;
  return true;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value)) fail("Malformed taskboard database");
  if (Object.keys(value).some((key) => key !== "nextId" && key !== "tasks")) {
    fail("Malformed taskboard database");
  }
  if (!Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) {
    fail("Malformed taskboard database");
  }
  if (!value.tasks.every(validateTask)) fail("Malformed taskboard database");
  const tasks = value.tasks as Task[];
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) fail("Malformed taskboard database");
  if (ids.some((id) => id >= (value.nextId as number))) fail("Malformed taskboard database");
  return value as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  const file = Bun.file(databasePath);
  if (!(await file.exists())) return { nextId: 1, tasks: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    fail("Malformed taskboard database");
  }
  return validateDatabase(parsed);
}

async function saveDatabase(database: Database): Promise<void> {
  const directory = dirname(databasePath);
  const temporaryPath = join(
    directory,
    `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporaryPath, databasePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseTags(value: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of value.split(",")) {
    const tag = normalizeTag(item);
    if (tag !== "" && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

function parsePositiveId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) fail(`Unknown flag: ${flag ?? ""}`);
    if (flags.has(flag)) fail(`Duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function main(): Promise<void> {
  const [command, ...args] = Bun.argv.slice(2);
  if (!command) fail("Missing command");

  const database = await loadDatabase();

  if (command === "add") {
    const flags = parseFlags(args, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title");
    if (title === undefined) fail("Missing required flag: --title");
    if (title.trim() === "") fail("Title must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isDate(due)) fail("Due date must be a valid YYYY-MM-DD date");
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      tags: flags.has("--tags") ? parseTags(flags.get("--tags")!) : [],
      ...(due === undefined ? {} : { due }),
      createdAt: new Date().toISOString(),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    output(task);
    return;
  }

  if (command === "list") {
    const flags = parseFlags(args, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("Status must be open or done");
    }
    const tagValue = flags.get("--tag");
    const tag = tagValue === undefined ? undefined : normalizeTag(tagValue);
    if (tag === "") fail("Tag must not be empty");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail("Overdue date must be a valid YYYY-MM-DD date");
    const tasks = database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
    output(tasks);
    return;
  }

  if (command === "done") {
    if (args.length !== 1) fail("Usage: done ID");
    const id = parsePositiveId(args[0]);
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`Task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    output(task);
    return;
  }

  if (command === "delete") {
    if (args.length !== 1) fail("Usage: delete ID");
    const id = parsePositiveId(args[0]);
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index === -1) fail(`Task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    output(task);
    return;
  }

  if (command === "stats") {
    if (args.length !== 0) fail("Usage: stats");
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length;
    output({ total: database.tasks.length, open, done, overdue });
    return;
  }

  fail(`Unknown command: ${command}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
