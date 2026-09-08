type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validate(input: unknown): Task[] {
  if (!record(input) || !Array.isArray(input.tasks)) throw new Error("tasks must be an array");
  const ids = new Set<string>();
  const tasks = input.tasks.map((value, index): Task => {
    if (!record(value)) throw new Error(`tasks[${index}] must be an object`);
    const { id, duration } = value;
    if (typeof id !== "string" || id.length === 0) throw new Error(`tasks[${index}].id must be a non-empty string`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
    ids.add(id);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`Task ${id}: duration must be a finite non-negative number`);
    }
    const dependencies = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependencies) || dependencies.some(dep => typeof dep !== "string")) {
      throw new Error(`Task ${id}: dependsOn must be an array of strings`);
    }
    if (new Set(dependencies).size !== dependencies.length) throw new Error(`Task ${id}: duplicate dependency`);
    if (dependencies.includes(id)) throw new Error(`Task ${id}: cannot depend on itself`);
    return { id, duration, dependsOn: [...dependencies].sort(compare) };
  });
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Task ${task.id}: unknown dependency ${dep}`);
    }
  }
  return tasks;
}

// A min-heap lets every newly ready task compete with all existing ready tasks.
class ReadyQueue {
  private items: string[] = [];
  push(id: string) {
    let i = this.items.length;
    this.items.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(this.items[parent], id) <= 0) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = id;
  }
  pop(): string | undefined {
    if (!this.items.length) return undefined;
    const first = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length) {
      let i = 0;
      while (2 * i + 1 < this.items.length) {
        let child = 2 * i + 1;
        if (child + 1 < this.items.length && compare(this.items[child + 1], this.items[child]) < 0) child++;
        if (compare(last, this.items[child]) <= 0) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return first;
  }
}

function findCycle(ids: string[], successors: Map<string, string[]>): string[] {
  const done = new Set<string>();
  const active = new Map<string, number>();
  for (const root of ids) {
    if (done.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    active.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edges = successors.get(frame.id)!;
      if (frame.next === edges.length) {
        done.add(frame.id);
        active.delete(frame.id);
        stack.pop();
        continue;
      }
      const next = edges[frame.next++];
      if (active.has(next)) return [...stack.slice(active.get(next)!).map(item => item.id), next];
      if (!done.has(next)) {
        active.set(next, stack.length);
        stack.push({ id: next, next: 0 });
      }
    }
  }
  throw new Error("Unable to locate cycle");
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ids = [...byId.keys()].sort(compare);
  const successors = new Map(ids.map(id => [id, [] as string[]]));
  const pending = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dep of task.dependsOn) successors.get(dep)!.push(task.id);
  for (const edges of successors.values()) edges.sort(compare);
  const ready = new ReadyQueue();
  for (const id of ids) if (pending.get(id) === 0) ready.push(id);
  const order: string[] = [];
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  let totalDuration = 0;
  let id: string | undefined;
  while ((id = ready.pop()) !== undefined) {
    const task = byId.get(id)!;
    let start = 0;
    let level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      level = Math.max(level, levels.get(dep)! + 1);
    }
    earliest[id] = { start, finish: start + task.duration };
    totalDuration = Math.max(totalDuration, earliest[id].finish);
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    order.push(id);
    for (const next of successors.get(id)!) {
      const remaining = pending.get(next)! - 1;
      pending.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  if (order.length !== tasks.length) throw new Error(`Cycle detected: ${findCycle(ids, successors).join(" -> ")}`);
  for (const layer of layers) layer.sort(compare);

  // Choose whole chains from the front. Choosing a best prefix before appending
  // is incorrect when zero-duration tasks make one tied prefix extend another.
  const suffix = new Map<string, number>();
  const nextOnPath = new Map<string, string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const current = order[i];
    let best = 0;
    for (const next of successors.get(current)!) {
      const length = suffix.get(next)!;
      if (length > best) {
        best = length;
        nextOnPath.set(current, next);
      }
    }
    suffix.set(current, byId.get(current)!.duration + best);
  }
  const criticalPath: string[] = [];
  let longest = -1;
  let head: string | undefined;
  for (const current of ids) {
    if (suffix.get(current)! > longest) {
      longest = suffix.get(current)!;
      head = current;
    }
  }
  while (head !== undefined) {
    criticalPath.push(head);
    head = nextOnPath.get(head);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
      throw new Error("Usage: bun run src/cli.ts plan INPUT.json (unknown commands and flags are not supported)");
    }
    let input: unknown;
    const text = await Bun.file(args[1]).text();
    try { input = JSON.parse(text); }
    catch { throw new Error(`Invalid JSON in ${args[1]}`); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
