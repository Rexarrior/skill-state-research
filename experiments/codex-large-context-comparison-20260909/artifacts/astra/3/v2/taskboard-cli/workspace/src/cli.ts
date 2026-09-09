import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

type Task = {
  id: number;
  title: string;
  status: 'open' | 'done';
  createdAt: string;
  tags: string[];
  due?: string;
  completedAt?: string;
};
type Database = { version: 1; nextId: number; tasks: Task[] };
const fail = (message: string): never => { throw new Error(message); };
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const normalizeTag = (tag: string) => tag.trim().toLowerCase();
const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function validateDatabase(value: unknown): asserts value is Database {
  if (!object(value) || value.version !== 1 || !positiveInteger(value.nextId) || !Array.isArray(value.tasks)) {
    fail('Malformed database');
  }
  const ids = new Set<number>();
  for (const task of value.tasks) {
    if (!object(task) || !positiveInteger(task.id) || task.id >= value.nextId || ids.has(task.id)
      || typeof task.title !== 'string' || !task.title.trim()
      || !['open', 'done'].includes(task.status as string) || !validTimestamp(task.createdAt)
      || !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== 'string' || !tag || normalizeTag(tag) !== tag)
      || new Set(task.tags).size !== task.tags.length
      || ('due' in task && !validDate(task.due))
      || (task.status === 'done' ? !validTimestamp(task.completedAt) : 'completedAt' in task)) {
      fail('Malformed database');
    }
    ids.add(task.id);
  }
}
const allowed: Record<string, string[]> = {
  add: ['title', 'tags', 'due'], list: ['status', 'tag', 'overdue'], done: [], delete: [], stats: [],
};
function parse(args: string[]) {
  const command = args[0];
  if (!command || !Object.hasOwn(allowed, command)) fail(`Unknown command: ${command ?? '(missing)'}`);
  const options: Record<string, string> = {};
  let id: number | undefined;
  if (command === 'done' || command === 'delete') {
    if (args.length !== 2 || !/^[1-9]\d*$/.test(args[1]!) || !positiveInteger(Number(args[1]))) fail('Expected one positive integer task ID');
    id = Number(args[1]);
  } else {
    for (let i = 1; i < args.length; i += 2) {
      const flag = args[i]!;
      const key = flag.slice(2);
      if (!flag.startsWith('--') || !allowed[command]!.includes(key)) fail(`Unknown flag: ${flag}`);
      if (Object.hasOwn(options, key)) fail(`Duplicate flag: ${flag}`);
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`Missing value for ${flag}`);
      options[key] = value;
    }
  }
  if (command === 'add' && !options.title?.trim()) fail('A non-empty --title is required');
  for (const key of ['due', 'overdue']) {
    if (options[key] !== undefined && !validDate(options[key])) fail(`Invalid --${key}: expected a real YYYY-MM-DD date`);
  }
  if (options.status !== undefined && !['open', 'done'].includes(options.status)) fail('Invalid --status: expected open or done');
  if (options.tag !== undefined && !normalizeTag(options.tag)) fail('--tag must not be empty');
  return { command, options, id };
}
async function load(file: string): Promise<Database> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { fail('Malformed database: invalid JSON'); }
  validateDatabase(data);
  return data;
}
async function save(file: string, database: Database) {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(database, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
function localToday() {
  const date = new Date();
  return `${date.getFullYear().toString().padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const overdue = (task: Task, date: string) => task.status === 'open' && task.due !== undefined && task.due < date;
async function main(): Promise<unknown> {
  const { command, options, id } = parse(process.argv.slice(2));
  const file = resolve(process.env.TASKBOARD_FILE ?? '.taskboard.json');
  const database = await load(file);
  if (command === 'list') {
    return database.tasks.filter(task =>
      (options.status === undefined || task.status === options.status)
      && (options.tag === undefined || task.tags.includes(normalizeTag(options.tag)))
      && (options.overdue === undefined || overdue(task, options.overdue)))
      .sort((a, b) => a.id - b.id);
  }
  if (command === 'stats') {
    const today = localToday();
    return {
      total: database.tasks.length,
      open: database.tasks.filter(task => task.status === 'open').length,
      done: database.tasks.filter(task => task.status === 'done').length,
      overdue: database.tasks.filter(task => overdue(task, today)).length,
    };
  }
  let result: Task;
  if (command === 'add') {
    if (database.nextId === Number.MAX_SAFE_INTEGER) fail('Task IDs exhausted');
    result = {
      id: database.nextId++, title: options.title!.trim(), status: 'open', createdAt: new Date().toISOString(),
      tags: [...new Set((options.tags ?? '').split(',').map(normalizeTag).filter(Boolean))],
      ...(options.due === undefined ? {} : { due: options.due }),
    };
    database.tasks.push(result);
  } else {
    const index = database.tasks.findIndex(task => task.id === id);
    if (index === -1) fail(`Task ${id} not found`);
    result = database.tasks[index]!;
    if (command === 'delete') database.tasks.splice(index, 1);
    else {
      if (result.status === 'done') return result;
      result.status = 'done';
      result.completedAt = new Date().toISOString();
    }
  }
  await save(file, database);
  return result;
}
try {
  console.log(JSON.stringify(await main()));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
