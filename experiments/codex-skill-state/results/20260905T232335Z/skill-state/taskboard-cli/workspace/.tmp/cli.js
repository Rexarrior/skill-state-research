// @bun
// src/cli.ts
import { randomUUID } from "crypto";
import { rename, unlink } from "fs/promises";
import { resolve } from "path";

class CliError extends Error {
}
var databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");
function fail(message) {
  throw new CliError(message);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function validateDate(value, label) {
  if (!isDate(value))
    fail(`${label} must be a valid date in YYYY-MM-DD format`);
  return value;
}
function isIsoTimestamp(value) {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}
function normalizeTag(tag) {
  return tag.trim().toLowerCase();
}
function normalizeTags(value) {
  const result = [];
  const seen = new Set;
  for (const raw of value.split(",")) {
    const tag = normalizeTag(raw);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}
function validateTask(value) {
  if (!isPlainObject(value))
    return false;
  const keys = new Set(Object.keys(value));
  for (const required of ["id", "title", "status", "tags", "createdAt"]) {
    if (!keys.has(required))
      return false;
  }
  if (![...keys].every((key) => ["id", "title", "status", "tags", "due", "createdAt", "completedAt"].includes(key))) {
    return false;
  }
  if (!Number.isSafeInteger(value.id) || value.id < 1)
    return false;
  if (typeof value.title !== "string" || value.title.trim() === "")
    return false;
  if (value.status !== "open" && value.status !== "done")
    return false;
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string" && tag !== "" && tag === normalizeTag(tag)))
    return false;
  if (new Set(value.tags).size !== value.tags.length)
    return false;
  if (value.due !== undefined && !isDate(value.due))
    return false;
  if (!isIsoTimestamp(value.createdAt))
    return false;
  if (value.status === "done" && !isIsoTimestamp(value.completedAt))
    return false;
  if (value.status === "open" && value.completedAt !== undefined)
    return false;
  return true;
}
function validateDatabase(value) {
  if (!isPlainObject(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || value.nextId < 1 || !Array.isArray(value.tasks)) {
    fail("malformed taskboard database");
  }
  if (!value.tasks.every(validateTask))
    fail("malformed taskboard database");
  const tasks = value.tasks;
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= value.nextId)) {
    fail("malformed taskboard database");
  }
  return value;
}
async function loadDatabase() {
  const file = Bun.file(databasePath);
  if (!await file.exists())
    return { version: 1, nextId: 1, tasks: [] };
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    fail("malformed taskboard database");
  }
  return validateDatabase(parsed);
}
async function saveDatabase(database) {
  const temporaryPath = `${databasePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(database, null, 2)}
`);
    await rename(temporaryPath, databasePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {
      return;
    });
    throw error;
  }
}
function parseOptions(args, allowed) {
  const options = new Map;
  for (let index = 0;index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !allowed.has(flag))
      fail(`unknown flag: ${flag ?? ""}`);
    if (options.has(flag))
      fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      fail(`missing value for ${flag}`);
    options.set(flag, value);
  }
  return options;
}
function parseId(args) {
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]))
    fail("ID must be a positive integer");
  const id = Number(args[0]);
  if (!Number.isSafeInteger(id))
    fail("ID must be a positive integer");
  return id;
}
function localToday() {
  const now = new Date;
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
async function run(args) {
  const [command, ...rest] = args;
  if (!command)
    fail("missing command");
  if (command === "add") {
    const options = parseOptions(rest, new Set(["--title", "--tags", "--due"]));
    const rawTitle = options.get("--title");
    if (rawTitle === undefined)
      fail("missing required flag: --title");
    const title = rawTitle.trim();
    if (!title)
      fail("title must not be empty");
    const due = options.has("--due") ? validateDate(options.get("--due"), "due") : undefined;
    const database = await loadDatabase();
    const task = {
      id: database.nextId,
      title,
      status: "open",
      tags: options.has("--tags") ? normalizeTags(options.get("--tags")) : [],
      ...due ? { due } : {},
      createdAt: new Date().toISOString()
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }
  if (command === "list") {
    const options = parseOptions(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = options.get("--status");
    if (status !== undefined && status !== "open" && status !== "done")
      fail("status must be open or done");
    const tag = options.has("--tag") ? normalizeTag(options.get("--tag")) : undefined;
    if (tag === "")
      fail("tag must not be empty");
    const overdue = options.has("--overdue") ? validateDate(options.get("--overdue"), "overdue") : undefined;
    const database = await loadDatabase();
    return database.tasks.filter((task) => status === undefined || task.status === status).filter((task) => tag === undefined || task.tags.includes(tag)).filter((task) => overdue === undefined || task.status === "open" && task.due !== undefined && task.due < overdue).sort((a, b) => a.id - b.id);
  }
  if (command === "done") {
    const id = parseId(rest);
    const database = await loadDatabase();
    const task = database.tasks.find((candidate) => candidate.id === id);
    if (!task)
      fail(`task ${id} not found`);
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }
  if (command === "delete") {
    const id = parseId(rest);
    const database = await loadDatabase();
    const index = database.tasks.findIndex((task) => task.id === id);
    if (index < 0)
      fail(`task ${id} not found`);
    const [deleted] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return deleted;
  }
  if (command === "stats") {
    if (rest.length)
      fail(`unknown flag: ${rest[0]}`);
    const database = await loadDatabase();
    const today = localToday();
    return {
      total: database.tasks.length,
      open: database.tasks.filter((task) => task.status === "open").length,
      done: database.tasks.filter((task) => task.status === "done").length,
      overdue: database.tasks.filter((task) => task.status === "open" && task.due !== undefined && task.due < today).length
    };
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
