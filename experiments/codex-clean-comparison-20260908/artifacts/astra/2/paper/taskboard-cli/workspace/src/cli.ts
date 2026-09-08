import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

type Task = { id: number; title: string; status: 'open' | 'done'; createdAt: string; tags: string[]; due?: string; completedAt?: string };
type Database = { version: 1; nextId: number; tasks: Task[] };
const file = resolve(process.env.TASKBOARD_FILE ?? '.taskboard.json');
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalizeTag = (tag: string) => tag.trim().toLowerCase();
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function iso(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
function validate(value: unknown): asserts value is Database {
  const bad = () => { throw new Error('Malformed database'); };
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) bad();
  const db = value as Database;
  const ids = new Set<number>();
  for (const task of db.tasks) {
    if (!object(task) || !Number.isSafeInteger(task.id) || task.id < 1 || task.id >= db.nextId || ids.has(task.id) ||
        typeof task.title !== 'string' || !task.title.trim() || !['open', 'done'].includes(task.status) || !iso(task.createdAt) ||
        !Array.isArray(task.tags) || task.tags.some(tag => typeof tag !== 'string' || !tag || normalizeTag(tag) !== tag) ||
        new Set(task.tags).size !== task.tags.length || (own(task, 'due') && !validDate(task.due)) ||
        (task.status === 'done' ? !iso(task.completedAt) : own(task, 'completedAt'))) bad();
    ids.add(task.id);
  }
}
function load(): Database {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, nextId: 1, tasks: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Malformed database: invalid JSON'); }
  validate(value);
  return value;
}
function save(db: Database) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(db, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.includes(key)) throw new Error(`Unknown flag or argument: ${key}`);
    if (own(result, key)) throw new Error(`Repeated flag: ${key}`);
    if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
    result[key] = args[i + 1];
  }
  return result;
}
function requireDate(value: string | undefined, name: string) {
  if (value !== undefined && !validDate(value)) throw new Error(`Invalid ${name}: expected a real YYYY-MM-DD date`);
}
function today() {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
const overdue = (task: Task, date: string) => task.status === 'open' && task.due !== undefined && task.due < date;
function main(args: string[]): unknown {
  const [command, ...rest] = args;
  if (!['add', 'list', 'done', 'delete', 'stats'].includes(command)) throw new Error(`Unknown command: ${command ?? '(missing)'}`);
  const flags = command === 'add' ? options(rest, ['--title', '--tags', '--due']) : command === 'list' ? options(rest, ['--status', '--tag', '--overdue']) : {};
  if (command === 'stats' && rest.length) throw new Error('stats takes no arguments');
  if ((command === 'done' || command === 'delete') && (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]) || !Number.isSafeInteger(Number(rest[0])))) throw new Error('Expected one positive integer task ID');
  if (command === 'add') {
    if (!flags['--title']?.trim()) throw new Error('A non-empty --title is required');
    requireDate(flags['--due'], 'due date');
  }
  if (command === 'list') {
    if (flags['--status'] !== undefined && !['open', 'done'].includes(flags['--status'])) throw new Error('Invalid status');
    if (flags['--tag'] !== undefined && !normalizeTag(flags['--tag'])) throw new Error('Tag must not be empty');
    requireDate(flags['--overdue'], 'overdue date');
  }
  const db = load();
  if (command === 'add') {
    if (db.nextId === Number.MAX_SAFE_INTEGER) throw new Error('Task ID limit reached');
    const task: Task = { id: db.nextId++, title: flags['--title'].trim(), status: 'open', createdAt: new Date().toISOString(), tags: [...new Set((flags['--tags'] ?? '').split(',').map(normalizeTag).filter(Boolean))] };
    if (flags['--due'] !== undefined) task.due = flags['--due'];
    db.tasks.push(task);
    save(db);
    return task;
  }
  if (command === 'list') return db.tasks.filter(task =>
    (flags['--status'] === undefined || task.status === flags['--status']) &&
    (flags['--tag'] === undefined || task.tags.includes(normalizeTag(flags['--tag']))) &&
    (flags['--overdue'] === undefined || overdue(task, flags['--overdue']))
  ).sort((a, b) => a.id - b.id);
  if (command === 'stats') {
    const date = today();
    return { total: db.tasks.length, open: db.tasks.filter(t => t.status === 'open').length, done: db.tasks.filter(t => t.status === 'done').length, overdue: db.tasks.filter(t => overdue(t, date)).length };
  }
  const index = db.tasks.findIndex(task => task.id === Number(rest[0]));
  if (index === -1) throw new Error(`Task not found: ${rest[0]}`);
  const task = db.tasks[index];
  if (command === 'delete') db.tasks.splice(index, 1);
  else if (task.status === 'done') return task;
  else { task.status = 'done'; task.completedAt = new Date().toISOString(); }
  save(db);
  return task;
}
try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.log('null');
  process.exitCode = 1;
}
