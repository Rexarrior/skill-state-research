#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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

const databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");

function fail(message: string): never {
  throw new CliError(message);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseTags(value: string): string[] {
  const tags = value.split(",").map(normalizeTag).filter(Boolean);
  return [...new Set(tags)];
}

function validateDatabase(value: unknown): Database {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("Malformed taskboard database: expected an object");
  }
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.nextId) || (candidate.nextId as number) < 1 || !Array.isArray(candidate.tasks)) {
    fail("Malformed taskboard database: invalid nextId or tasks");
  }

  const ids = new Set<number>();
  for (const item of candidate.tasks) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      fail("Malformed taskboard database: invalid task");
    }
    const task = item as Record<string, unknown>;
    if (!Number.isSafeInteger(task.id) || (task.id as number) < 1 || ids.has(task.id as number)) {
      fail("Malformed taskboard database: invalid or duplicate task id");
    }
    ids.add(task.id as number);
    if (typeof task.title !== "string" || task.title.trim() === "" || (task.status !== "open" && task.status !== "done")) {
      fail("Malformed taskboard database: invalid task fields");
    }
    if (!Array.isArray(task.tags) || task.tags.some((tag) => typeof tag !== "string" || !tag || tag !== normalizeTag(tag)) || new Set(task.tags).size !== task.tags.length) {
      fail("Malformed taskboard database: invalid task tags");
    }
    if (task.due !== undefined && (typeof task.due !== "string" || !isDate(task.due))) {
      fail("Malformed taskboard database: invalid due date");
    }
    if (!isIsoTimestamp(task.createdAt)) {
      fail("Malformed taskboard database: invalid createdAt");
    }
    if (task.status === "done" && !isIsoTimestamp(task.completedAt)) {
      fail("Malformed taskboard database: done task lacks completedAt");
    }
    if (task.status === "open" && task.completedAt !== undefined) {
      fail("Malformed taskboard database: open task has completedAt");
    }
  }
  const maxId = ids.size ? Math.max(...ids) : 0;
  if ((candidate.nextId as number) <= maxId) {
    fail("Malformed taskboard database: nextId is not greater than existing ids");
  }
  return candidate as unknown as Database;
}

async function loadDatabase(): Promise<Database> {
  let raw: string;
  try {
    raw = await readFile(databasePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { nextId: 1, tasks: [] };
    throw error;
  }
  try {
    return validateDatabase(JSON.parse(raw));
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail("Malformed taskboard database: invalid JSON");
  }
}

async function saveDatabase(database: Database): Promise<void> {
  const temporaryPath = `${databasePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function parseOptions(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag)) fail(`Unknown flag: ${flag ?? ""}`);
    if (options.has(flag)) fail(`Duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`Missing value for ${flag}`);
    options.set(flag, value);
  }
  return options;
}

function parseId(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
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
  if (!command) fail("Missing command");

  if (command === "add") {
    const options = parseOptions(args.slice(1), new Set(["--title", "--tags", "--due"]));
    const title = options.get("--title");
    if (title === undefined) fail("Missing required flag: --title");
    if (title.trim() === "") fail("Title cannot be empty");
    const due = options.get("--due");
    if (due !== undefined && !isDate(due)) fail("Due date must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    const task: Task = {
      id: database.nextId,
      title,
      status: "open",
      tags: options.has("--tags") ? parseTags(options.get("--tags")!) : [],
      ...(due === undefined ? {} : { due }),
      createdAt: new Date().toISOString(),
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }

  if (command === "list") {
    const options = parseOptions(args.slice(1), new Set(["--status", "--tag", "--overdue"]));
    const status = options.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("Status must be open or done");
    const tag = options.has("--tag") ? normalizeTag(options.get("--tag")!) : undefined;
    if (tag === "") fail("Tag cannot be empty");
    const overdue = options.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail("Overdue date must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((a, b) => a.id - b.id);
  }

  if (command === "done") {
    if (args.length !== 2) fail(args.length < 2 ? "Missing task ID" : "Too many arguments for done");
    const id = parseId(args[1]);
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
    if (args.length !== 2) fail(args.length < 2 ? "Missing task ID" : "Too many arguments for delete");
    const id = parseId(args[1]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index < 0) fail(`Task ${id} not found`);
    const [deleted] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return deleted;
  }

  if (command === "stats") {
    if (args.length !== 1) fail("stats does not accept arguments");
    const database = await loadDatabase();
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length;
    return { total: database.tasks.length, open, done, overdue };
  }

  fail(`Unknown command: ${command}`);
}

try {
  const result = await run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`taskboard: ${message}\n`);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
}
