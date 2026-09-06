// @bun
// src/cli.ts
import { rename, unlink, writeFile } from "fs/promises";
import { dirname, basename, join } from "path";

class CliError extends Error {
}
var databasePath = process.env.TASKBOARD_FILE ?? ".taskboard.json";
function fail(message) {
  throw new CliError(message);
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isIsoTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}
function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function validateTask(value) {
  if (!isObject(value))
    return false;
  const keys = Object.keys(value);
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  if (keys.some((key) => !allowed.has(key)))
    return false;
  if (!Number.isSafeInteger(value.id) || value.id < 1)
    return false;
  if (typeof value.title !== "string" || value.title.trim() === "")
    return false;
  if (value.status !== "open" && value.status !== "done")
    return false;
  if (!isIsoTimestamp(value.createdAt))
    return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string" || tag === "" || tag !== tag.trim().toLowerCase()))
    return false;
  if (new Set(value.tags).size !== value.tags.length)
    return false;
  if (value.due !== undefined && !isValidDate(value.due))
    return false;
  if (value.completedAt !== undefined && !isIsoTimestamp(value.completedAt))
    return false;
  if (value.status === "open" && value.completedAt !== undefined)
    return false;
  if (value.status === "done" && value.completedAt === undefined)
    return false;
  return true;
}
function validateDatabase(value) {
  if (!isObject(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || value.nextId < 1 || !Array.isArray(value.tasks)) {
    return fail("malformed taskboard database");
  }
  if (Object.keys(value).some((key) => !["version", "nextId", "tasks"].includes(key)))
    fail("malformed taskboard database");
  if (!value.tasks.every(validateTask))
    fail("malformed taskboard database");
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= value.nextId))
    fail("malformed taskboard database");
  return value;
}
async function readDatabase() {
  if (databasePath === "")
    fail("TASKBOARD_FILE must not be empty");
  try {
    const text = await Bun.file(databasePath).text();
    return validateDatabase(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof CliError)
      throw error instanceof CliError ? error : new CliError("malformed taskboard database");
    if (isObject(error) && error.code === "ENOENT")
      return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
}
async function saveDatabase(database) {
  const directory = dirname(databasePath);
  const temporary = join(directory, `.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}
`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, databasePath);
  } catch (error) {
    await unlink(temporary).catch(() => {
      return;
    });
    throw error;
  }
}
function parseFlags(args, allowed) {
  const flags = new Map;
  for (let index = 0;index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--"))
      fail(`unexpected argument: ${flag ?? ""}`);
    if (!allowed.has(flag))
      fail(`unknown flag: ${flag}`);
    if (flags.has(flag))
      fail(`duplicate flag: ${flag}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      fail(`missing value for ${flag}`);
    flags.set(flag, value);
  }
  return flags;
}
function normalizeTags(value) {
  if (value === undefined)
    return [];
  const tags = value.split(",").map((tag) => tag.trim().toLowerCase());
  if (tags.some((tag) => tag === ""))
    fail("tags must not be empty");
  return [...new Set(tags)];
}
function parseId(value) {
  if (value === undefined || !/^[1-9]\d*$/.test(value))
    fail("ID must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id))
    fail("ID must be a safe integer");
  return id;
}
function localToday() {
  const now = new Date;
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
async function execute(args) {
  const [command, ...rest] = args;
  if (!command)
    fail("missing command");
  if (command === "add") {
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const title = flags.get("--title")?.trim();
    if (!title)
      fail("--title is required and must not be empty");
    const due = flags.get("--due");
    if (due !== undefined && !isValidDate(due))
      fail("--due must be a valid YYYY-MM-DD date");
    const database = await readDatabase();
    const task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: normalizeTags(flags.get("--tags")),
      ...due === undefined ? {} : { due }
    };
    database.nextId += 1;
    database.tasks.push(task);
    await saveDatabase(database);
    return task;
  }
  if (command === "list") {
    const flags = parseFlags(rest, new Set(["--status", "--tag", "--overdue"]));
    const status = flags.get("--status");
    if (status !== undefined && status !== "open" && status !== "done")
      fail("--status must be open or done");
    const tag = flags.get("--tag")?.trim().toLowerCase();
    if (flags.has("--tag") && !tag)
      fail("--tag must not be empty");
    const overdue = flags.get("--overdue");
    if (overdue !== undefined && !isValidDate(overdue))
      fail("--overdue must be a valid YYYY-MM-DD date");
    const database = await readDatabase();
    return database.tasks.filter((task) => status === undefined || task.status === status).filter((task) => tag === undefined || task.tags.includes(tag)).filter((task) => overdue === undefined || task.status === "open" && task.due !== undefined && task.due < overdue).sort((a, b) => a.id - b.id);
  }
  if (command === "done" || command === "delete") {
    if (rest.length !== 1)
      fail(`${command} requires exactly one ID`);
    const id = parseId(rest[0]);
    const database = await readDatabase();
    const index = database.tasks.findIndex((task2) => task2.id === id);
    if (index < 0)
      fail(`task ${id} not found`);
    if (command === "delete") {
      const [deleted] = database.tasks.splice(index, 1);
      await saveDatabase(database);
      return deleted;
    }
    const task = database.tasks[index];
    if (task.status === "open") {
      task.status = "done";
      task.completedAt = new Date().toISOString();
      await saveDatabase(database);
    }
    return task;
  }
  if (command === "stats") {
    if (rest.length !== 0)
      fail("stats does not accept arguments");
    const database = await readDatabase();
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
  const result = await execute(Bun.argv.slice(2));
  console.log(JSON.stringify(result));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  console.error(`taskboard: ${message}`);
  process.exitCode = 1;
}
