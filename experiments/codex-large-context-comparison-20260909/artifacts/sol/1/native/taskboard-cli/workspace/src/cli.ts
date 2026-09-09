#!/usr/bin/env bun

import { rename, unlink } from "node:fs/promises";

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

const databasePath = process.env.TASKBOARD_FILE ?? ".taskboard.json";

function fail(message: string): never {
  throw new CliError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1) return false;
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function validateTask(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set(["id", "title", "status", "tags", "due", "createdAt", "completedAt"]);
  if (keys.some((key) => !allowed.has(key))) return false;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 1) return false;
  if (typeof value.title !== "string" || value.title.trim() === "") return false;
  if (value.status !== "open" && value.status !== "done") return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== normalizeTag(tag))) return false;
  if (new Set(value.tags).size !== value.tags.length) return false;
  if (value.due !== undefined && !isDate(value.due)) return false;
  if (!isIsoTimestamp(value.createdAt)) return false;
  if (value.status === "done") return isIsoTimestamp(value.completedAt);
  return value.completedAt === undefined;
}

function validateDatabase(value: unknown): value is Database {
  if (!isRecord(value)) return false;
  if (value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) return false;
  if (!value.tasks.every(validateTask)) return false;
  const ids = value.tasks.map((task) => task.id);
  return new Set(ids).size === ids.length && ids.every((id) => id < (value.nextId as number));
}

async function loadDatabase(): Promise<Database> {
  let contents: string;
  try {
    contents = await Bun.file(databasePath).text();
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (code === "ENOENT") return { version: 1, nextId: 1, tasks: [] };
    fail(`cannot read database: ${error instanceof Error ? error.message : String(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    fail("malformed database: invalid JSON");
  }
  if (!validateDatabase(value)) fail("malformed database: invalid schema");
  return value;
}

async function saveDatabase(database: Database): Promise<void> {
  const suffix = `${process.pid}-${crypto.randomUUID()}`;
  const temporaryPath = `${databasePath}.tmp-${suffix}`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {}
    fail(`cannot write database: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function parseTags(value: string): string[] {
  const tags = value.split(",").map(normalizeTag);
  if (tags.some((tag) => tag === "")) fail("tags must not be empty");
  return [...new Set(tags)];
}

function parseId(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id)) fail("ID must be a safe positive integer");
  return id;
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--")) fail(`unexpected argument: ${flag ?? ""}`);
    if (!allowed.has(flag)) fail(`unknown flag: ${flag}`);
    if (result.has(flag)) fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    result.set(flag, value);
  }
  return result;
}

function localToday(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function run(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command) fail("missing command");

  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title")?.trim();
    if (title === undefined) fail("missing required flag: --title");
    if (title === "") fail("title must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isDate(due)) fail("due date must be a valid YYYY-MM-DD date");
    const tags = flags.has("--tags") ? parseTags(flags.get("--tags")!) : [];
    const database = await loadDatabase();
    if (database.nextId === Number.MAX_SAFE_INTEGER) fail("task ID limit reached");
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
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done") fail("status must be open or done");
    const tagValue = flags.get("--tag");
    const tag = tagValue === undefined ? undefined : normalizeTag(tagValue);
    if (tag === "") fail("tag must not be empty");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isDate(overdue)) fail("overdue date must be a valid YYYY-MM-DD date");
    const database = await loadDatabase();
    return database.tasks
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => tag === undefined || task.tags.includes(tag))
      .filter((task) => overdue === undefined || (task.status === "open" && task.due !== undefined && task.due < overdue))
      .sort((left, right) => left.id - right.id);
  }

  if (command === "done") {
    if (rest.length !== 1) fail("usage: done ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task) fail(`task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }

  if (command === "delete") {
    if (rest.length !== 1) fail("usage: delete ID");
    const id = parseId(rest[0]);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index === -1) fail(`task ${id} not found`);
    const [deleted] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return deleted;
  }

  if (command === "stats") {
    if (rest.length !== 0) fail(`unknown flag or argument: ${rest[0]}`);
    const database = await loadDatabase();
    const today = localToday();
    const open = database.tasks.filter((task) => task.status === "open").length;
    const done = database.tasks.length - open;
    const overdue = database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length;
    return { total: database.tasks.length, open, done, overdue };
  }

  fail(`unknown command: ${command}`);
}

try {
  const result = await run(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(message);
  process.exitCode = 1;
}
