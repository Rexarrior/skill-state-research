export interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function validate(input: unknown): Task[] {
  if (!isObject(input) || !Array.isArray(input.tasks)) {
    throw new Error('Input must be an object with a "tasks" array');
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    const label = `tasks[${index}]`;
    if (!isObject(value)) throw new Error(`${label} must be an object`);
    const { id, duration } = value;
    if (typeof id !== "string" || id.length === 0) throw new Error(`${label}.id must be a non-empty string`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${JSON.stringify(id)}`);
    ids.add(id);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }
    const dependsOn = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependsOn) || !dependsOn.every((id) => typeof id === "string")) {
      throw new Error(`${label}.dependsOn must be an array of strings`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`${label}.dependsOn contains duplicate ids`);
    if (dependsOn.includes(id)) throw new Error(`Task ${JSON.stringify(id)} cannot depend on itself`);
    return { id, duration, dependsOn: [...dependsOn].sort(compare) };
  });
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Task ${JSON.stringify(task.id)} has unknown dependency ${JSON.stringify(dependency)}`);
    }
  }
  return tasks;
}

// Iterative DFS avoids overflowing the call stack on long dependency chains.
function findCycle(ids: string[], tasks: Map<string, Task>): string[] {
  const finished = new Set<string>();
  const active = new Map<string, number>();
  const stack: { id: string; next: number }[] = [];
  for (const root of ids) {
    if (finished.has(root)) continue;
    stack.push({ id: root, next: 0 });
    active.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const dependencies = tasks.get(frame.id)!.dependsOn;
      if (frame.next === dependencies.length) {
        stack.pop();
        active.delete(frame.id);
        finished.add(frame.id);
        continue;
      }
      const next = dependencies[frame.next++];
      const position = active.get(next);
      if (position !== undefined) return [...stack.slice(position).map((frame) => frame.id), next];
      if (!finished.has(next)) {
        active.set(next, stack.length);
        stack.push({ id: next, next: 0 });
      }
    }
  }
  throw new Error("Internal error: cycle not found");
}

class MinHeap {
  private values: string[] = [];
  get size() { return this.values.length; }
  push(id: string) {
    const values = this.values;
    let index = values.length;
    values.push(id);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compare(values[parent], id) <= 0) break;
      values[index] = values[parent];
      index = parent;
    }
    values[index] = id;
  }
  pop(): string {
    const values = this.values;
    const first = values[0];
    const last = values.pop()!;
    if (values.length) {
      let index = 0;
      while (index * 2 + 1 < values.length) {
        let child = index * 2 + 1;
        if (child + 1 < values.length && compare(values[child + 1], values[child]) < 0) child++;
        if (compare(last, values[child]) <= 0) break;
        values[index] = values[child];
        index = child;
      }
      values[index] = last;
    }
    return first;
  }
}

export function plan(input: unknown) {
  const validated = validate(input);
  const tasks = new Map(validated.map((task) => [task.id, task]));
  const ids = [...tasks.keys()].sort(compare);
  const children = new Map(ids.map((id) => [id, [] as string[]]));
  const remaining = new Map(ids.map((id) => [id, tasks.get(id)!.dependsOn.length]));
  for (const id of ids) for (const dependency of tasks.get(id)!.dependsOn) children.get(dependency)!.push(id);
  const ready = new MinHeap();
  for (const id of ids) if (remaining.get(id) === 0) ready.push(id);
  const order: string[] = [];
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
  let totalDuration = 0;
  while (ready.size) {
    const id = ready.pop();
    const task = tasks.get(id)!;
    let start = 0;
    let level = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency].finish);
      level = Math.max(level, levels.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== ids.length) throw new Error(`Cycle detected: ${findCycle(ids, tasks).join(" -> ")}`);
  for (const layer of layers) layer.sort(compare);

  // Mark all chains that attain the makespan using forward finish times.
  // Greedy traversal then compares the full sequence, including prefix ties.
  const reachesEnd = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (earliest[id].finish === totalDuration || children.get(id)!.some((child) =>
      reachesEnd.has(child) && earliest[id].finish === earliest[child].start)) reachesEnd.add(id);
  }
  const criticalPath: string[] = [];
  let current = ids.find((id) => earliest[id].start === 0 && reachesEnd.has(id));
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current].finish === totalDuration) break;
    const finish = earliest[current].finish;
    current = children.get(current)!.find((child) => reachesEnd.has(child) && earliest[child].start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
      throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
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
