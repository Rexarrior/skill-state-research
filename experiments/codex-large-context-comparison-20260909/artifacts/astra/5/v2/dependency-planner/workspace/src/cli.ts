type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function validate(input: unknown): Task[] {
  if (!record(input) || !Array.isArray(input.tasks)) throw new Error('Input must contain a "tasks" array');
  const ids = new Set<string>();
  const tasks = input.tasks.map((value, index): Task => {
    const label = `tasks[${index}]`;
    if (!record(value)) throw new Error(`${label} must be an object`);
    if (typeof value.id !== "string" || value.id.length === 0) throw new Error(`${label}.id must be a non-empty string`);
    if (ids.has(value.id)) throw new Error(`Duplicate task id: ${JSON.stringify(value.id)}`);
    ids.add(value.id);
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0)
      throw new Error(`${label}.duration must be a finite non-negative number`);
    const deps = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(deps) || deps.some(id => typeof id !== "string"))
      throw new Error(`${label}.dependsOn must be an array of strings`);
    if (new Set(deps).size !== deps.length) throw new Error(`${label}.dependsOn contains duplicate ids`);
    if (deps.includes(value.id)) throw new Error(`Task ${JSON.stringify(value.id)} cannot depend on itself`);
    return { id: value.id, duration: value.duration, dependsOn: [...deps].sort(compare) };
  });
  for (const task of tasks) for (const dep of task.dependsOn)
    if (!ids.has(dep)) throw new Error(`Task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dep)}`);
  return tasks.sort((a, b) => compare(a.id, b.id));
}

// A min-heap keeps Kahn's ready queue lexicographic without repeated sorting.
class ReadyQueue {
  private values: string[] = [];
  get size() { return this.values.length; }
  push(value: string) {
    const a = this.values;
    let i = a.length;
    a.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(a[parent]!, value) <= 0) break;
      a[i] = a[parent]!;
      i = parent;
    }
    a[i] = value;
  }
  pop(): string {
    const a = this.values, first = a[0]!, last = a.pop()!;
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let child = i * 2 + 1;
        if (child + 1 < a.length && compare(a[child + 1]!, a[child]!) < 0) child++;
        if (compare(last, a[child]!) <= 0) break;
        a[i] = a[child]!;
        i = child;
      }
      a[i] = last;
    }
    return first;
  }
}

function findCycle(tasks: Task[], byId: Map<string, Task>): string[] {
  const color = new Map<string, number>();
  const positions = new Map<string, number>();
  const stack: { id: string; next: number }[] = [];
  for (const task of tasks) {
    if (color.has(task.id)) continue;
    stack.push({ id: task.id, next: 0 });
    color.set(task.id, 1);
    positions.set(task.id, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const deps = byId.get(frame.id)!.dependsOn;
      if (frame.next === deps.length) {
        color.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
        continue;
      }
      const dep = deps[frame.next++]!;
      if (color.get(dep) === 1) return [...stack.slice(positions.get(dep)!).map(f => f.id), dep];
      if (!color.has(dep)) {
        positions.set(dep, stack.length);
        color.set(dep, 1);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  throw new Error("Cycle detection failed");
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map(tasks.map(task => [task.id, [] as string[]]));
  const pending = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  const ready = new ReadyQueue();
  for (const task of tasks) {
    if (!task.dependsOn.length) ready.push(task.id);
    for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  }
  const order: string[] = [], layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  let totalDuration = 0;
  while (ready.size) {
    const id = ready.pop(), task = byId.get(id)!;
    let start = 0, level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep]!.finish);
      level = Math.max(level, levels.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration exceeds finite number range at ${JSON.stringify(id)}`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = pending.get(child)! - 1;
      pending.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== tasks.length) throw new Error(`Dependency cycle: ${findCycle(tasks, byId).join(" -> ")}`);
  for (const layer of layers) layer.sort(compare);

  // Mark nodes that can reach a maximum finish through timing-tight edges.
  // Greedy forward selection compares full sequences, including zero-time
  // prefixes. Ending a sequence wins over extending its identical prefix.
  const reachesEnd = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    if (earliest[id]!.finish === totalDuration || children.get(id)!.some(child =>
      reachesEnd.has(child) && earliest[id]!.finish === earliest[child]!.start)) reachesEnd.add(id);
  }
  const criticalPath: string[] = [];
  let current = tasks.find(task => earliest[task.id]!.start === 0 && reachesEnd.has(task.id))?.id;
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current]!.finish === totalDuration) break;
    const finish = earliest[current]!.finish;
    current = children.get(current)!.find(child => reachesEnd.has(child) && earliest[child]!.start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args[1]!.startsWith("-"))
      throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
    const text = await Bun.file(args[1]!).text();
    let input: unknown;
    try { input = JSON.parse(text); }
    catch { throw new Error("Invalid JSON in input file"); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
