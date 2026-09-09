// @bun
// src/cli.ts
import { rename, unlink, writeFile } from "fs/promises";
import { dirname, basename, resolve } from "path";

class CliError extends Error {
}
var databasePath = resolve(process.env.TASKBOARD_FILE || ".taskboard.json");
function fail(message) {
  throw new CliError(message);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12)
    return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}
function requireDate(value, label) {
  if (!isValidDate(value))
    fail(`${label} must be a valid date in YYYY-MM-DD format`);
  return value;
}
function validateTask(value) {
  if (!isRecord(value))
    return false;
  const allowed = new Set(["id", "title", "status", "createdAt", "tags", "due", "completedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    return false;
  if (!Number.isSafeInteger(value.id) || value.id < 1)
    return false;
  if (typeof value.title !== "string" || value.title.trim() === "")
    return false;
  if (value.status !== "open" && value.status !== "done")
    return false;
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)))
    return false;
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string"))
    return false;
  if (new Set(value.tags).size !== value.tags.length)
    return false;
  if (value.due !== undefined && (typeof value.due !== "string" || !isValidDate(value.due)))
    return false;
  if (value.completedAt !== undefined && (typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))))
    return false;
  if (value.status === "open" && value.completedAt !== undefined)
    return false;
  if (value.status === "done" && value.completedAt === undefined)
    return false;
  return true;
}
function validateDatabase(value) {
  if (!isRecord(value))
    return false;
  if (Object.keys(value).some((key) => key !== "nextId" && key !== "tasks"))
    return false;
  if (!Number.isSafeInteger(value.nextId) || value.nextId < 1)
    return false;
  if (!Array.isArray(value.tasks) || value.tasks.some((task) => !validateTask(task)))
    return false;
  const ids = value.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length)
    return false;
  return ids.every((id) => id < value.nextId);
}
async function loadDatabase() {
  let text;
  try {
    text = await Bun.file(databasePath).text();
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT")
      return { nextId: 1, tasks: [] };
    fail(`cannot read database: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("database is malformed: invalid JSON");
  }
  if (!validateDatabase(parsed))
    fail("database is malformed: invalid structure");
  return parsed;
}
async function saveDatabase(database) {
  const directory = dirname(databasePath);
  const temporaryPath = `${directory}/.${basename(databasePath)}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}
`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, databasePath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {}
    fail(`cannot write database: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function parseFlags(args, definitions) {
  const flags = new Map;
  for (let index = 0;index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith("--"))
      fail(`unexpected argument: ${flag ?? ""}`);
    if (!definitions.has(flag))
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
function parseId(args, command) {
  if (args.length !== 1)
    fail(`usage: ${command} ID`);
  if (!/^[1-9]\d*$/.test(args[0]))
    fail("ID must be a positive integer");
  const id = Number(args[0]);
  if (!Number.isSafeInteger(id))
    fail("ID must be a safe positive integer");
  return id;
}
function normalizedTags(value) {
  if (value === undefined)
    return [];
  return [...new Set(value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
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
    const flags = parseFlags(rest, new Set(["--title", "--tags", "--due"]));
    const rawTitle = flags.get("--title");
    if (rawTitle === undefined)
      fail("missing required flag: --title");
    const title = rawTitle.trim();
    if (title === "")
      fail("title must not be empty");
    const dueValue = flags.get("--due");
    const due = dueValue === undefined ? undefined : requireDate(dueValue, "due date");
    const database = await loadDatabase();
    const task = {
      id: database.nextId,
      title,
      status: "open",
      createdAt: new Date().toISOString(),
      tags: normalizedTags(flags.get("--tags")),
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
    if (status !== undefined && status !== "open" && status !== "done") {
      fail("status must be open or done");
    }
    const rawTag = flags.get("--tag");
    const tag = rawTag?.trim().toLowerCase();
    if (rawTag !== undefined && tag === "")
      fail("tag must not be empty");
    const overdueValue = flags.get("--overdue");
    const overdue = overdueValue === undefined ? undefined : requireDate(overdueValue, "overdue date");
    const database = await loadDatabase();
    return database.tasks.filter((task) => status === undefined || task.status === status).filter((task) => tag === undefined || task.tags.includes(tag)).filter((task) => overdue === undefined || task.status === "open" && task.due !== undefined && task.due < overdue).sort((left, right) => left.id - right.id);
  }
  if (command === "done") {
    const id = parseId(rest, "done");
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
    const id = parseId(rest, "delete");
    const database = await loadDatabase();
    const index = database.tasks.findIndex((candidate) => candidate.id === id);
    if (index === -1)
      fail(`task ${id} not found`);
    const [task] = database.tasks.splice(index, 1);
    await saveDatabase(database);
    return task;
  }
  if (command === "stats") {
    if (rest.length !== 0)
      fail(`unknown flag or argument: ${rest[0]}`);
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
  process.stdout.write(`${JSON.stringify(result)}
`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ error: message })}
`);
  process.stderr.write(`${message}
`);
  process.exitCode = 1;
}
