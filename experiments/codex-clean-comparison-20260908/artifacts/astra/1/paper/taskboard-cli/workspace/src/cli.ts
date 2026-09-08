import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

type Task = { id: number; title: string; status: 'open' | 'done'; createdAt: string; tags: string[]; due?: string; completedAt?: string };
type Database = { version: 1; nextId: number; tasks: Task[] };
const file = resolve(process.env.TASKBOARD_FILE ?? '.taskboard.json');
const normalize = (s: string) => s.trim().toLowerCase();
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function date(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parsed = new Date(`${v}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
}
function timestamp(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
}
function validate(value: unknown): asserts value is Database {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.nextId) || (value.nextId as number) < 1 || !Array.isArray(value.tasks)) throw new Error('Malformed database');
  const ids = new Set<number>();
  for (const t of value.tasks) {
    if (!object(t) || !Number.isSafeInteger(t.id) || (t.id as number) < 1 || (t.id as number) >= (value.nextId as number) || ids.has(t.id as number)
      || typeof t.title !== 'string' || !t.title.trim() || !['open', 'done'].includes(t.status as string) || !timestamp(t.createdAt)
      || !Array.isArray(t.tags) || t.tags.some(tag => typeof tag !== 'string' || !tag || normalize(tag) !== tag) || new Set(t.tags).size !== t.tags.length
      || ('due' in t && !date(t.due)) || (t.status === 'done' ? !timestamp(t.completedAt) : 'completedAt' in t)) throw new Error('Malformed database');
    ids.add(t.id as number);
  }
}
async function load(): Promise<Database> {
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, nextId: 1, tasks: [] }; throw error; }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Malformed database: invalid JSON'); }
  validate(value);
  return value;
}
async function save(db: Database) {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(db) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}
function options(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.includes(key)) throw new Error(`Unknown flag or argument: ${key}`);
    if (key in result) throw new Error(`Duplicate flag: ${key}`);
    if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
    result[key] = args[i + 1];
  }
  return result;
}
function today() {
  const d = new Date();
  return `${d.getFullYear().toString().padStart(4, '0')}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
}
const overdue = (t: Task, day: string) => t.status === 'open' && t.due !== undefined && t.due < day;
async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  if (!['add', 'list', 'done', 'delete', 'stats'].includes(command)) throw new Error(`Unknown command: ${command ?? '(missing)'}`);
  const db = await load();
  if (command === 'add') {
    const opts = options(args, ['--title', '--tags', '--due']);
    if (!opts['--title']?.trim()) throw new Error('A non-empty --title is required');
    if ('--due' in opts && !date(opts['--due'])) throw new Error('Invalid due date; expected YYYY-MM-DD');
    if (db.nextId >= Number.MAX_SAFE_INTEGER) throw new Error('Task IDs exhausted');
    const task: Task = { id: db.nextId++, title: opts['--title'].trim(), status: 'open', createdAt: new Date().toISOString(), tags: [...new Set((opts['--tags'] ?? '').split(',').map(normalize).filter(Boolean))] };
    if ('--due' in opts) task.due = opts['--due'];
    db.tasks.push(task);
    await save(db);
    return task;
  }
  if (command === 'list') {
    const opts = options(args, ['--status', '--tag', '--overdue']);
    if ('--status' in opts && !['open', 'done'].includes(opts['--status'])) throw new Error('Invalid status');
    if ('--overdue' in opts && !date(opts['--overdue'])) throw new Error('Invalid overdue date; expected YYYY-MM-DD');
    return db.tasks.filter(t => (!('--status' in opts) || t.status === opts['--status']) && (!('--tag' in opts) || t.tags.includes(normalize(opts['--tag']))) && (!('--overdue' in opts) || overdue(t, opts['--overdue']))).sort((a, b) => a.id - b.id);
  }
  if (command === 'stats') {
    options(args, []);
    return { total: db.tasks.length, open: db.tasks.filter(t => t.status === 'open').length, done: db.tasks.filter(t => t.status === 'done').length, overdue: db.tasks.filter(t => overdue(t, today())).length };
  }
  if (args.length !== 1 || !/^[1-9]\d*$/.test(args[0]) || !Number.isSafeInteger(Number(args[0]))) throw new Error(`${command} requires one positive integer ID`);
  const task = db.tasks.find(t => t.id === Number(args[0]));
  if (!task) throw new Error(`Task ${args[0]} not found`);
  if (command === 'delete') db.tasks = db.tasks.filter(t => t.id !== task.id);
  else if (task.status === 'done') return task;
  else { task.status = 'done'; task.completedAt = new Date().toISOString(); }
  await save(db);
  return task;
}
try { console.log(JSON.stringify(await main())); }
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.log(JSON.stringify({ error: message }));
  process.exitCode = 1;
}
