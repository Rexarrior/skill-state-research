type Task = { id: string; duration: number; dependsOn: string[] };
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function validate(input: unknown): Task[] {
  if (!input || typeof input !== 'object' || !Array.isArray((input as any).tasks))
    throw new Error('Input must be an object with a tasks array');
  const ids = new Set<string>();
  const tasks = (input as any).tasks.map((task: any, index: number): Task => {
    const where = `tasks[${index}]`;
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error(`${where} must be an object`);
    if (typeof task.id !== 'string' || task.id.length === 0) throw new Error(`${where}.id must be a non-empty string`);
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (typeof task.duration !== 'number' || !Number.isFinite(task.duration) || task.duration < 0)
      throw new Error(`${where}.duration must be a finite non-negative number`);
    const deps = task.dependsOn === undefined ? [] : task.dependsOn;
    if (!Array.isArray(deps) || deps.some((id: unknown) => typeof id !== 'string'))
      throw new Error(`${where}.dependsOn must be an array of strings`);
    if (new Set(deps).size !== deps.length) throw new Error(`${where}.dependsOn contains duplicates`);
    if (deps.includes(task.id)) throw new Error(`Task ${task.id} cannot depend on itself`);
    return { id: task.id, duration: task.duration, dependsOn: [...deps].sort(cmp) };
  });
  for (const task of tasks) for (const dep of task.dependsOn)
    if (!ids.has(dep)) throw new Error(`Task ${task.id} references unknown dependency: ${dep}`);
  return tasks.sort((a: Task, b: Task) => cmp(a.id, b.id));
}

// A minimum heap ensures lexicographic selection across all currently ready tasks.
class Ready {
  private items: string[] = [];
  push(id: string) {
    const a = this.items;
    let i = a.length;
    a.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmp(a[p]!, id) <= 0) break;
      a[i] = a[p]!;
      i = p;
    }
    a[i] = id;
  }
  pop(): string | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const result = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1;
        if (c + 1 < a.length && cmp(a[c + 1]!, a[c]!) < 0) c++;
        if (cmp(last, a[c]!) <= 0) break;
        a[i] = a[c]!;
        i = c;
      }
      a[i] = last;
    }
    return result;
  }
}

function findCycle(tasks: Task[], byId: Map<string, Task>): string[] {
  const color = new Map<string, number>();
  const active = new Map<string, number>();
  for (const task of tasks) {
    if (color.has(task.id)) continue;
    const stack = [{ id: task.id, next: 0 }];
    color.set(task.id, 1);
    active.set(task.id, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const deps = byId.get(frame.id)!.dependsOn;
      if (frame.next === deps.length) {
        color.set(frame.id, 2);
        active.delete(frame.id);
        stack.pop();
        continue;
      }
      const dep = deps[frame.next++]!;
      if (color.get(dep) === 1)
        return [...stack.slice(active.get(dep)!).map(f => f.id), dep];
      if (!color.has(dep)) {
        color.set(dep, 1);
        active.set(dep, stack.length);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  throw new Error('Cycle detection failed');
}

function plan(tasks: Task[]) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const children = new Map(tasks.map(t => [t.id, [] as string[]]));
  const pending = new Map(tasks.map(t => [t.id, t.dependsOn.length]));
  const ready = new Ready();
  for (const task of tasks) {
    if (!task.dependsOn.length) ready.push(task.id);
    for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  }
  const order: string[] = [];
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
  let totalDuration = 0;
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    const task = byId.get(id)!;
    let start = 0, level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep]!.finish);
      level = Math.max(level, levels.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration overflow at task ${id}`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = pending.get(child)! - 1;
      pending.set(child, count);
      if (!count) ready.push(child);
    }
  }
  if (order.length !== tasks.length)
    throw new Error(`Dependency cycle: ${findCycle(tasks, byId).join(' -> ')}`);
  for (const layer of layers) layer.sort(cmp);

  // A critical chain follows tight edges and ends at the makespan. Mark all
  // viable suffixes, then choose greedily by id. This also handles zero-duration
  // prefixes, where choosing just one best predecessor path can lose a tie.
  const viable = new Set<string>();
  const next = new Map<string, string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    if (earliest[id]!.finish === totalDuration) viable.add(id);
    for (const child of children.get(id)!) {
      if (viable.has(child) && earliest[child]!.start === earliest[id]!.finish) {
        viable.add(id);
        if (!next.has(id)) next.set(id, child);
      }
    }
  }
  const criticalPath: string[] = [];
  let current = tasks.find(t => earliest[t.id]!.start === 0 && viable.has(t.id))?.id;
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current]!.finish === totalDuration) break;
    current = next.get(current);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

try {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== 'plan' || args[1]!.startsWith('-'))
    throw new Error('Usage: bun run src/cli.ts plan INPUT.json (no flags supported)');
  let input: unknown;
  const text = await Bun.file(args[1]!).text();
  try { input = JSON.parse(text); }
  catch { throw new Error('Invalid JSON in input file'); }
  console.log(JSON.stringify(plan(validate(input))));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
