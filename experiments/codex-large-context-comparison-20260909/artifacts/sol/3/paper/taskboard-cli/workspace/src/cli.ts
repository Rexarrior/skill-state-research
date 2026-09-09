#!/usr/bin/env bun

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
  version: 1;
  nextId: number;
  tasks: Task[];
}

class CliError extends Error {}

const databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["id", "title", "status", "tags", "due", "createdAt", "completedAt"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string" && tag !== "")) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (value.status === "done" && !isIsoTimestamp(value.completedAt)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  return true;
}

function validateDatabase(value: unknown): asserts value is Database {
  if (!isRecord(value)
    || value.version !== 1
    || !Number.isSafeInteger(value.nextId)
    || (value.nextId as number) < 1
    || !Array.isArray(value.tasks)
    || !value.tasks.every(validateTask)) {
    fail(`Malformed taskboard database: ${databasePath}`);
  }
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= (value.nextId as number))) {
    fail(`Malformed taskboard database: ${databasePath}`);
  }
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await readFile(databasePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`Malformed taskboard database: ${databasePath}`);
  }
  validateDatabase(value);
  return value;
}

async function saveDatabase(database: Database): Promise<void> {
  await mkdir(dirname(databasePath), { recursive: true });
  const temporaryPath = `${databasePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try { await unlink(temporaryPath); } catch { /* Nothing to clean up. */ }
    throw error;
  }
}

interface ParsedOptions {
  positional: string[];
  options: Map<string, string>;
}

function parseArguments(args: string[], allowedFlags: ReadonlySet<string>): ParsedOptions {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    if (!allowedFlags.has(name)) fail(`Unknown flag: --${name}`);
    if (options.has(name)) fail(`Flag specified more than once: --${name}`);
    const value = equals === -1 ? args[++index] : token.slice(equals + 1);
    if (value === undefined || value.startsWith("--")) fail(`Missing value for --${name}`);
    options.set(name, value);
  }
  return { positional, options };
}

function requireDate(value: string, label: string): string {
  if (!isDate(value)) fail(`Invalid ${label}: ${value}`);
  return value;
}

function normalizeTag(tag: string): string {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) fail("Tags must not be empty");
  return normalized;
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const command = args[0];
  const rest = args.slice(1);

  if (command === "add") {
    const { positional, options } = parseArguments(rest, new Set(["title", "tags", "due"]));
    if (positional.length) fail(`Unexpected argument: ${positional[0]}`);
    const title = options.get("title")?.trim();
    if (!title) fail("--title is required and must not be empty");
    const tags = options.has("tags")
      ? [...new Set(options.get("tags")!.split(",").map(normalizeTag))]
      : [];
    const due = options.has("due") ? requireDate(options.get("due")!, "due date") : undefined;
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      tags,
      ...(due === undefined ? {} : { due }),
      createdAt: new Date().toISOString(),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const { positional, options } = parseArguments(rest, new Set(["status", "tag", "overdue"]));
    if (positional.length) fail(`Unexpected argument: ${positional[0]}`);
    const status = options.get("status");
    if (status !== undefined && status !== "open" && status !== "done") fail(`Invalid status: ${status}`);
    const tag = options.has("tag") ? normalizeTag(options.get("tag")!) : undefined;
    const overdue = options.has("overdue") ? requireDate(options.get("overdue")!, "overdue date") : undefined;
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    const { positional } = parseArguments(rest, new Set());
    if (positional.length !== 1) fail("Usage: done ID");
    const id = parseId(positional[0]);
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`Task not found: ${id}`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    const { positional } = parseArguments(rest, new Set());
    if (positional.length !== 1) fail("Usage: delete ID");
    const id = parseId(positional[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index === -1) fail(`Task not found: ${id}`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }

  if (command === "stats") {
    const { positional } = parseArguments(rest, new Set());
    if (positional.length) fail(`Unexpected argument: ${positional[0]}`);
    const database = await loadDatabase();
    const today = localToday();
    return {
      total: database.tasks.length,
      open: database.tasks.filter((task) => task.status === "open").length,
      done: database.tasks.filter((task) => task.status === "done").length,
      overdue: database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
    };
  }

  fail(command === undefined ? "Missing command" : `Unknown command: ${command}`);
}

try {
  const result = await run(process.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(message);
  process.exitCode = 1;
}
