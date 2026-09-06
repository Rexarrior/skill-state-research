#!/usr/bin/env bun

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

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

function isValidDate(value: string): boolean {
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

function requireDate(value: string, option: string): string {
  if (!isValidDate(value)) fail(`${option} must be a valid date in YYYY-MM-DD format`);
  return value;
}

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTags(value: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const tag = normalizeTag(part);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = new Set(Object.keys(value));
  const allowed = ["id", "title", "status", "createdAt", "tags", "due", "completedAt"];
  if ([...keys].some((key) => !allowed.includes(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.tags.some((tag) => tag === "" || tag !== normalizeTag(tag))) return false;
  if (value.due !== undefined && (typeof value.due !== "string" || !isValidDate(value.due))) return false;
  if (value.completedAt !== undefined && (typeof value.completedAt !== "string" || Number.isNaN(Date.parse(value.completedAt)))) return false;
  if (value.status === "open" && value.completedAt !== undefined) return false;
  if (value.status === "done" && typeof value.completedAt !== "string") return false;
  return true;
}

function validateDatabase(value: unknown): value is Database {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !["version", "nextId", "tasks"].includes(key))) return false;
  if (value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1) return false;
  if (!Array.isArray(value.tasks) || !value.tasks.every(validateTask)) return false;
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) return false;
  return ids.every((id) => id < (value.nextId as number));
}

async function loadDatabase(): Promise<Database> {
  let text: string;
  try {
    text = await readFile(databasePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`malformed database: ${databasePath}`);
  }
  if (!validateDatabase(parsed)) fail(`malformed database: ${databasePath}`);
  return parsed;
}

async function saveDatabase(database: Database): Promise<void> {
  const parent = dirname(databasePath);
  await mkdir(parent, { recursive: true });
  const temporaryPath = `${parent}/.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {}
    throw error;
  }
}

interface ParsedArguments {
  options: Map<string, string>;
  positionals: string[];
}

function parseArguments(args: string[], allowed: ReadonlySet<string>): ParsedArguments {
  const options = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    if (!allowed.has(argument)) fail(`unknown flag: ${argument}`);
    if (options.has(argument)) fail(`duplicate flag: ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${argument}`);
    options.set(argument, value);
    index += 1;
  }
  return { options, positionals };
}

function requireNoPositionals(positionals: string[]): void {
  if (positionals.length > 0) fail(`unexpected argument: ${positionals[0]}`);
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a positive integer");
  return id;
}

async function add(args: string[]): Promise<Task> {
  const { options, positionals } = parseArguments(args, new Set(["--title", "--tags", "--due"]));
  requireNoPositionals(positionals);
  const title = options.get("--title")?.trim();
  if (!title) fail("--title is required and must not be empty");
  const dueValue = options.get("--due");
  const database = await loadDatabase();
  const task: Task = {
    id: database.nextId,
    title,
    status: "open",
    createdAt: new Date().toISOString(),
    tags: normalizeTags(options.get("--tags") ?? ""),
  };
  if (dueValue !== undefined) task.due = requireDate(dueValue, "--due");
  database.nextId += 1;
  database.tasks.push(task);
  await saveDatabase(database);
  return task;
}

async function list(args: string[]): Promise<Task[]> {
  const { options, positionals } = parseArguments(args, new Set(["--status", "--tag", "--overdue"]));
  requireNoPositionals(positionals);
  const status = options.get("--status");
  if (status !== undefined && status !== "open" && status !== "done") fail("--status must be open or done");
  const rawTag = options.get("--tag");
  const tag = rawTag === undefined ? undefined : normalizeTag(rawTag);
  if (rawTag !== undefined && !tag) fail("--tag must not be empty");
  const overdueValue = options.get("--overdue");
  const overdue = overdueValue === undefined ? undefined : requireDate(overdueValue, "--overdue");
  const database = await loadDatabase();
  return database.tasks
    .filter((task) => status === undefined || task.status === status)
    .filter((task) => tag === undefined || task.tags.includes(tag))
    .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
    .sort((left, right) => left.id - right.id);
}

async function done(args: string[]): Promise<Task> {
  const { positionals } = parseArguments(args, new Set());
  if (positionals.length !== 1) fail("usage: done ID");
  const id = parseId(positionals[0]);
  const database = await loadDatabase();
  const task = database.tasks.find((candidate) => candidate.id === id);
  if (!task) fail(`task not found: ${id}`);
  if (task.status === "open") {
    task.status = "done";
    task.completedAt = new Date().toISOString();
    await saveDatabase(database);
  }
  return task;
}

async function deleteTask(args: string[]): Promise<Task> {
  const { positionals } = parseArguments(args, new Set());
  if (positionals.length !== 1) fail("usage: delete ID");
  const id = parseId(positionals[0]);
  const database = await loadDatabase();
  const index = database.tasks.findIndex((task) => task.id === id);
  if (index === -1) fail(`task not found: ${id}`);
  const [task] = database.tasks.splice(index, 1);
  await saveDatabase(database);
  return task;
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function stats(args: string[]): Promise<{ total: number; open: number; done: number; overdue: number }> {
  const { positionals } = parseArguments(args, new Set());
  requireNoPositionals(positionals);
  const database = await loadDatabase();
  const today = localToday();
  return {
    total: database.tasks.length,
    open: database.tasks.filter((task) => task.status === "open").length,
    done: database.tasks.filter((task) => task.status === "done").length,
    overdue: database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length,
  };
}

async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "add": return add(args);
    case "list": return list(args);
    case "done": return done(args);
    case "delete": return deleteTask(args);
    case "stats": return stats(args);
    case undefined: fail("missing command");
    default: fail(`unknown command: ${command}`);
  }
}

try {
  const result = await main();
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(message);
  process.exitCode = 1;
}
