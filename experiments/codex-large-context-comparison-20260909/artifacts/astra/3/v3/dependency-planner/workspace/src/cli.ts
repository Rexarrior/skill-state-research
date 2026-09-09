type Task = { id: string; duration: number; dependsOn: string[] };
type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validate(input: unknown): Task[] {
  if (!record(input) || !Array.isArray(input.tasks)) {
    throw new Error('Input must be an object containing a "tasks" array');
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    const label = `tasks[${index}]`;
    if (!record(value)) throw new Error(`${label} must be an object`);
    if (typeof value.id !== "string" || value.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string`);
    }
    if (ids.has(value.id)) throw new Error(`Duplicate task id: ${JSON.stringify(value.id)}`);
    ids.add(value.id);
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }
    const dependencies = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== "string")) {
      throw new Error(`${label}.dependsOn must be an array of strings`);
    }
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error(`${label}.dependsOn contains duplicate ids`);
    }
    return { id: value.id, duration: value.duration, dependsOn: [...dependencies].sort(compare) };
  });
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) throw new Error(`Task ${JSON.stringify(task.id)} cannot depend on itself`);
      if (!ids.has(dependency)) throw new Error(`Task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}`);
    }
  }
  return tasks.sort((a, b) => compare(a.id, b.id));
}

// A min-heap makes the next ready task independent of input and edge order.
class ReadyQueue {
  private ids: string[] = [];
  push(id: string) {
    let i = this.ids.length;
    this.ids.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(this.ids[parent], id) <= 0) break;
      this.ids[i] = this.ids[parent];
      i = parent;
    }
    this.ids[i] = id;
  }
  pop(): string | undefined {
    if (!this.ids.length) return undefined;
    const first = this.ids[0];
    const last = this.ids.pop()!;
    if (this.ids.length) {
      let i = 0;
      while (2 * i + 1 < this.ids.length) {
        let child = 2 * i + 1;
        if (child + 1 < this.ids.length && compare(this.ids[child + 1], this.ids[child]) < 0) child++;
        if (compare(last, this.ids[child]) <= 0) break;
        this.ids[i] = this.ids[child];
        i = child;
      }
      this.ids[i] = last;
    }
    return first;
  }
}

// Iterative DFS avoids call-stack limits on long cycles. Edges point from
// a task to its dependencies, so each arrow describes a dependency.
function cycle(tasks: Task[], byId: Map<string, Task>): string[] {
  const color = new Map<string, number>();
  for (const task of tasks) {
    if (color.has(task.id)) continue;
    const stack = [{ id: task.id, next: 0 }];
    const positions = new Map<string, number>([[task.id, 0]]);
    color.set(task.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const dependencies = byId.get(frame.id)!.dependsOn;
      if (frame.next === dependencies.length) {
        color.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
        continue;
      }
      const id = dependencies[frame.next++];
      if (color.get(id) === 1) return [...stack.slice(positions.get(id)!).map(f => f.id), id];
      if (!color.has(id)) {
        color.set(id, 1);
        positions.set(id, stack.length);
        stack.push({ id, next: 0 });
      }
    }
  }
  throw new Error("Unable to locate cycle");
}

export function plan(input: unknown): Plan {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map(tasks.map(task => [task.id, [] as string[]]));
  const remaining = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  const ready = new ReadyQueue();
  for (const task of tasks) {
    if (!task.dependsOn.length) ready.push(task.id);
    for (const dependency of task.dependsOn) children.get(dependency)!.push(task.id);
  }
  const order: string[] = [];
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Plan["earliest"] = Object.create(null);
  let totalDuration = 0;
  let id: string | undefined;
  while ((id = ready.pop()) !== undefined) {
    const task = byId.get(id)!;
    let start = 0;
    let level = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency].finish);
      level = Math.max(level, levels.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration exceeds finite numeric range at ${JSON.stringify(id)}`);
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
  if (order.length !== tasks.length) {
    const display = (id: string) => /[\s\x00-\x1f]|->/.test(id) ? JSON.stringify(id) : id;
    throw new Error(`Dependency cycle: ${cycle(tasks, byId).map(display).join(" -> ")}`);
  }
  for (const layer of layers) layer.sort(compare);

  // Mark nodes that can reach a maximum finish through timing-tight edges.
  // Greedily choose the smallest eligible next id, stopping when the target
  // is reached: a sequence sorts before any extension of itself.
  const eligible = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const current = order[i];
    if (earliest[current].finish === totalDuration || children.get(current)!.some(child =>
      eligible.has(child) && earliest[current].finish === earliest[child].start)) eligible.add(current);
  }
  const criticalPath: string[] = [];
  let current = tasks.find(task => eligible.has(task.id) && earliest[task.id].start === 0)?.id;
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current].finish === totalDuration) break;
    current = children.get(current)!.find(child => eligible.has(child) && earliest[child].start === earliest[current!].finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
      throw new Error("Usage: bun run src/cli.ts plan INPUT.json (unknown commands and flags are not supported)");
    }
    let text: string;
    try { text = await Bun.file(args[1]).text(); }
    catch (error) { throw new Error(`Cannot read input ${JSON.stringify(args[1])}: ${error instanceof Error ? error.message : error}`); }
    let input: unknown;
    try { input = JSON.parse(text); }
    catch (error) { throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : error}`); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
