export type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validate(input: unknown): Task[] {
  if (!record(input) || !Array.isArray(input.tasks)) throw new Error("Input must contain a tasks array");
  const ids = new Set<string>();
  const tasks = input.tasks.map((value, index): Task => {
    if (!record(value)) throw new Error(`Task ${index} must be an object`);
    const { id, duration } = value;
    if (typeof id !== "string" || id.length === 0) throw new Error(`Task ${index} needs a non-empty string id`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
    ids.add(id);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`Task ${id}: duration must be a finite non-negative number`);
    }
    const dependsOn = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== "string")) {
      throw new Error(`Task ${id}: dependsOn must be an array of strings`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Task ${id}: duplicate dependency`);
    if (dependsOn.includes(id)) throw new Error(`Task ${id}: self-dependency (${id} -> ${id})`);
    return { id, duration, dependsOn: [...dependsOn].sort(compare) };
  });
  for (const task of tasks) for (const dep of task.dependsOn) {
    if (!ids.has(dep)) throw new Error(`Task ${task.id}: unknown dependency ${dep}`);
  }
  return tasks;
}

// A min heap ensures that newly ready tasks compete with all other ready tasks.
class ReadyQueue {
  private items: string[] = [];
  push(id: string) {
    const a = this.items;
    let i = a.length;
    a.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compare(a[p]!, id) <= 0) break;
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
      while (2 * i + 1 < a.length) {
        let child = 2 * i + 1;
        if (child + 1 < a.length && compare(a[child + 1]!, a[child]!) < 0) child++;
        if (compare(last, a[child]!) <= 0) break;
        a[i] = a[child]!;
        i = child;
      }
      a[i] = last;
    }
    return result;
  }
}

function cycle(tasks: Map<string, Task>): string[] {
  const done = new Set<string>();
  const active = new Map<string, number>();
  for (const root of [...tasks.keys()].sort(compare)) {
    if (done.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    active.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const deps = tasks.get(frame.id)!.dependsOn;
      if (frame.next === deps.length) {
        done.add(frame.id);
        active.delete(frame.id);
        stack.pop();
        continue;
      }
      const dep = deps[frame.next++]!;
      const position = active.get(dep);
      if (position !== undefined) return [...stack.slice(position).map(f => f.id), dep];
      if (!done.has(dep)) {
        active.set(dep, stack.length);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  throw new Error("Internal error: cycle not found");
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map(tasks.map(task => [task.id, [] as string[]]));
  const remaining = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  const ready = new ReadyQueue();
  for (const task of tasks) {
    if (!task.dependsOn.length) ready.push(task.id);
    for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  }
  const order: string[] = [];
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  let totalDuration = 0;
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    const task = byId.get(id)!;
    let start = 0;
    let level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep]!.finish);
      level = Math.max(level, levels.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration exceeds finite numeric range at task ${id}`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (!count) ready.push(child);
    }
  }
  if (order.length !== tasks.length) throw new Error(`Dependency cycle: ${cycle(byId).join(" -> ")}`);
  for (const layer of layers) layer.sort(compare);

  // Keep edges that realize the computed earliest times. Working with forward
  // times avoids changing floating-point addition order when choosing a path.
  const reachesEnd = new Set<string>();
  const next = new Map<string, string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    if (earliest[id]!.finish === totalDuration) {
      reachesEnd.add(id); // A sequence sorts before any extension of itself.
      continue;
    }
    let successor: string | undefined;
    for (const child of children.get(id)!) {
      if (reachesEnd.has(child) && earliest[id]!.finish === earliest[child]!.start &&
          (successor === undefined || compare(child, successor) < 0)) successor = child;
    }
    if (successor !== undefined) {
      reachesEnd.add(id);
      next.set(id, successor);
    }
  }
  const bestStart = order.filter(id => earliest[id]!.start === 0 && reachesEnd.has(id)).sort(compare)[0];
  const criticalPath: string[] = [];
  for (let id = bestStart; id !== undefined; id = next.get(id)) criticalPath.push(id);
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args[1]!.startsWith("-")) {
      throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
    }
    let input: unknown;
    try { input = JSON.parse(await Bun.file(args[1]!).text()); }
    catch (error) { throw new Error(`Cannot read/parse input: ${error instanceof Error ? error.message : String(error)}`); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
