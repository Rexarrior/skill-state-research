type Task = { id: string; duration: number; dependsOn: string[] };
type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function validate(input: unknown): Task[] {
  if (!input || typeof input !== 'object' || !Array.isArray((input as any).tasks)) {
    throw new Error('Input must be an object with a tasks array');
  }
  const ids = new Set<string>();
  const tasks: Task[] = (input as any).tasks.map((task: any, i: number) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error(`tasks[${i}] must be an object`);
    if (typeof task.id !== 'string' || task.id.length === 0) throw new Error(`tasks[${i}].id must be a non-empty string`);
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (typeof task.duration !== 'number' || !Number.isFinite(task.duration) || task.duration < 0) {
      throw new Error(`Invalid duration for ${task.id}: expected a finite non-negative number`);
    }
    const deps = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(deps) || deps.some((id: unknown) => typeof id !== 'string')) {
      throw new Error(`dependsOn for ${task.id} must be an array of strings`);
    }
    if (new Set(deps).size !== deps.length) throw new Error(`Duplicate dependency for ${task.id}`);
    if (deps.includes(task.id)) throw new Error(`Task ${task.id} cannot depend on itself (cycle: ${task.id} -> ${task.id})`);
    return { id: task.id, duration: task.duration, dependsOn: [...deps].sort(compare) };
  });
  for (const task of tasks) for (const dep of task.dependsOn) {
    if (!ids.has(dep)) throw new Error(`Unknown dependency ${dep} for ${task.id}`);
  }
  return tasks.sort((a, b) => compare(a.id, b.id));
}

// A min-heap ensures the smallest currently ready id always runs next.
class ReadyQueue {
  private items: string[] = [];
  push(id: string) {
    const a = this.items;
    let i = a.length;
    a.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compare(a[p], id) <= 0) break;
      a[i] = a[p]; i = p;
    }
    a[i] = id;
  }
  pop(): string | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const first = a[0], last = a.pop()!;
    if (a.length) {
      let i = 0;
      while (2 * i + 1 < a.length) {
        let child = 2 * i + 1;
        if (child + 1 < a.length && compare(a[child + 1], a[child]) < 0) child++;
        if (compare(last, a[child]) <= 0) break;
        a[i] = a[child]; i = child;
      }
      a[i] = last;
    }
    return first;
  }
}

function findCycle(tasks: Task[], byId: Map<string, Task>): string[] {
  const color = new Map<string, number>();
  for (const task of tasks) {
    if (color.has(task.id)) continue;
    const stack = [{ id: task.id, next: 0 }];
    const positions = new Map([[task.id, 0]]);
    color.set(task.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const deps = byId.get(frame.id)!.dependsOn;
      if (frame.next === deps.length) {
        color.set(frame.id, 2); positions.delete(frame.id); stack.pop(); continue;
      }
      const dep = deps[frame.next++];
      if (color.get(dep) === 1) return [...stack.slice(positions.get(dep)!).map(f => f.id), dep];
      if (!color.has(dep)) {
        color.set(dep, 1); positions.set(dep, stack.length); stack.push({ id: dep, next: 0 });
      }
    }
  }
  throw new Error('Cycle detection failed');
}

export function plan(input: unknown): Plan {
  const tasks = validate(input);
  const byId = new Map(tasks.map(t => [t.id, t]));
  const children = new Map(tasks.map(t => [t.id, [] as string[]]));
  const pending = new Map(tasks.map(t => [t.id, t.dependsOn.length]));
  const ready = new ReadyQueue();
  for (const t of tasks) {
    if (!t.dependsOn.length) ready.push(t.id);
    for (const dep of t.dependsOn) children.get(dep)!.push(t.id);
  }
  const order: string[] = [], layers: string[][] = [];
  const depth = new Map<string, number>();
  const earliest: Plan['earliest'] = Object.create(null);
  let totalDuration = 0;
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    const task = byId.get(id)!;
    let start = 0, level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      level = Math.max(level, depth.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Duration sum overflow at ${id}`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    depth.set(id, level);
    (layers[level] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = pending.get(child)! - 1;
      pending.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== tasks.length) throw new Error(`Cycle detected: ${findCycle(tasks, byId).join(' -> ')}`);
  for (const layer of layers) layer.sort(compare);

  // Find nodes that can reach a maximum finish via timing-tight edges.
  // Greedy full-sequence selection avoids the prefix-tie bug of retaining
  // just one best predecessor path when zero-duration tasks are present.
  const reachesEnd = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (earliest[id].finish === totalDuration || children.get(id)!.some(child =>
      reachesEnd.has(child) && earliest[id].finish === earliest[child].start)) reachesEnd.add(id);
  }
  const criticalPath: string[] = [];
  let current = tasks.find(t => earliest[t.id].start === 0 && reachesEnd.has(t.id))?.id;
  while (current !== undefined) {
    criticalPath.push(current);
    // A sequence sorts before any strict extension of itself.
    if (earliest[current].finish === totalDuration) break;
    current = children.get(current)!.find(child =>
      reachesEnd.has(child) && earliest[current!].finish === earliest[child].start);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== 'plan' || args[1].startsWith('-')) {
      throw new Error('Usage: bun run src/cli.ts plan INPUT.json (no flags supported)');
    }
    let input: unknown;
    try { input = JSON.parse(await Bun.file(args[1]).text()); }
    catch (error) { throw new Error(`Cannot read/parse ${args[1]}: ${(error as Error).message}`); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
