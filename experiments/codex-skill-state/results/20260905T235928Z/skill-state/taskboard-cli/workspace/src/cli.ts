#!/usr/bin/env bun

import { rename, unlink } from "node:fs/promises";
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
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isValidDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
  return [...new Set(value.split(",").map(normalizeTag).filter(Boolean))];
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([
    "id",
    "title",
    "status",
    "tags",
    "due",
    "createdAt",
    "completedAt",
  ]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) {
    return false;
  }
  const tags = value.tags as string[];
  if (
    tags.some((tag) => tag === "" || normalizeTag(tag) !== tag) ||
    new Set(tags).size !== tags.length
  ) {
    return false;
  }
  if (value.due !== undefined && !isValidDate(value.due)) return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt)) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && value.completedAt === undefined) return false;
  return true;
}

function validateDatabase(value: unknown): Database {
  if (!isRecord(value)) fail("Malformed task database");
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("version") ||
    !keys.includes("nextId") ||
    !keys.includes("tasks") ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.nextId) ||
    (value.nextId as number) < 1 ||
    !Array.isArray(value.tasks) ||
    !value.tasks.every(validateTask)
  ) {
    fail("Malformed task database");
  }

  const tasks = value.tasks as Task[];
  const ids = tasks.map((task) => task.id);
  const maximumId = ids.length === 0 ? 0 : Math.max(...ids);
  if (new Set(ids).size !== ids.length || (value.nextId as number) <= maximumId) {
    fail("Malformed task database");
  }
  return value as unknown as Database;
}

async function readDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { version: 1, nextId: 1, tasks: [] };
    }
    throw error;
  }

  try {
    return validateDatabase(JSON.parse(text));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("Malformed task database");
  }
}

async function writeDatabase(database: Database): Promise<void> {
  const temporaryPath = `${databasePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, {
      createPath: false,
    });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    throw error;
  }
}

type ParsedArguments = {
  positionals: string[];
  options: Map<string, string>;
};

function parseArguments(args: string[], allowed: Set<string>): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (!allowed.has(argument)) fail(`Unknown flag: ${argument}`);
    if (options.has(argument)) fail(`Duplicate flag: ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`Missing value for ${argument}`);
    }
    options.set(argument, value);
    index += 1;
  }
  return { positionals, options };
}

function requireNoPositionals(positionals: string[]): void {
  if (positionals.length > 0) fail(`Unexpected argument: ${positionals[0]}`);
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

function requireDate(value: string, flag: string): string {
  if (!isValidDate(value)) fail(`${flag} must be a valid YYYY-MM-DD date`);
  return value;
}

function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function add(args: string[]): Promise<Task> {
  const { positionals, options } = parseArguments(
    args,
    new Set(["--title", "--tags", "--due"]),
  );
  requireNoPositionals(positionals);
  const title = options.get("--title");
  if (title === undefined) fail("Missing required flag: --title");
  if (title.trim() === "") fail("Title must not be empty");

  const dueValue = options.get("--due");
  const task: Task = {
    id: 0,
    title: title.trim(),
    status: "open",
    tags: normalizeTags(options.get("--tags") ?? ""),
    createdAt: new Date().toISOString(),
  };
  if (dueValue !== undefined) task.due = requireDate(dueValue, "--due");

  const database = await readDatabase();
  task.id = database.nextId;
  database.nextId += 1;
  database.tasks.push(task);
  await writeDatabase(database);
  return task;
}

async function list(args: string[]): Promise<Task[]> {
  const { positionals, options } = parseArguments(
    args,
    new Set(["--status", "--tag", "--overdue"]),
  );
  requireNoPositionals(positionals);
  const status = options.get("--status");
  if (status !== undefined && status !== "open" && status !== "done") {
    fail("--status must be open or done");
  }
  const tagValue = options.get("--tag");
  const tag = tagValue === undefined ? undefined : normalizeTag(tagValue);
  if (tag !== undefined && tag === "") fail("--tag must not be empty");
  const overdueValue = options.get("--overdue");
  const overdue =
    overdueValue === undefined ? undefined : requireDate(overdueValue, "--overdue");

  const database = await readDatabase();
  return database.tasks
    .filter((task) => status === undefined || task.status === status)
    .filter((task) => tag === undefined || task.tags.includes(tag))
    .filter(
      (task) =>
        overdue === undefined ||
        (task.status === "open" && task.due !== undefined && task.due < overdue),
    )
    .sort((left, right) => left.id - right.id);
}

async function done(args: string[]): Promise<Task> {
  const { positionals } = parseArguments(args, new Set());
  if (positionals.length !== 1) fail("Usage: done ID");
  const id = parseId(positionals[0]);
  const database = await readDatabase();
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (task === undefined) fail(`Task ${id} not found`);
  if (task.status === "open") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    await writeDatabase(database);
  }
  return task;
}

async function remove(args: string[]): Promise<Task> {
  const { positionals } = parseArguments(args, new Set());
  if (positionals.length !== 1) fail("Usage: delete ID");
  const id = parseId(positionals[0]);
  const database = await readDatabase();
  const index = database.tasks.findIndex((task) => task.id === id);
  if (index === -1) fail(`Task ${id} not found`);
  const [task] = database.tasks.splice(index, 1);
  await writeDatabase(database);
  return task!;
}

async function stats(args: string[]): Promise<{
  total: number;
  open: number;
  done: number;
  overdue: number;
}> {
  const { positionals } = parseArguments(args, new Set());
  requireNoPositionals(positionals);
  const database = await readDatabase();
  const today = localToday();
  return {
    total: database.tasks.length,
    open: database.tasks.filter((task) => task.status === "open").length,
    done: database.tasks.filter((task) => task.status === "done").length,
    overdue: database.tasks.filter(
      (task) => task.status === "open" && task.due !== undefined && task.due < today,
    ).length,
  };
}

async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "add":
      return add(args);
    case "list":
      return list(args);
    case "done":
      return done(args);
    case "delete":
      return remove(args);
    case "stats":
      return stats(args);
    case undefined:
      fail("Missing command");
    default:
      fail(`Unknown command: ${command}`);
  }
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
}
