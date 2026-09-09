export interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

export interface Plan {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validate(input: unknown): Task[] {
  if (!record(input) || !Array.isArray(input.tasks)) {
    throw new Error('Input must be an object with a "tasks" array');
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    const label = `tasks[${index}]`;
    if (!record(value)) throw new Error(`${label} must be an object`);
    if (typeof value.id !== "string" || value.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string`);
    }
    if (ids.has(value.id)) throw new Error(`Duplicate task id: ${value.id}`);
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
    if (dependencies.includes(value.id)) throw new Error(`Task ${value.id} cannot depend on itself`);
    return { id: value.id, duration: value.duration, dependsOn: [...dependencies].sort() };
  });
  for (const task of tasks) {
    for (const id of task.dependsOn) {
      if (!ids.has(id)) throw new Error(`Task ${task.id} depends on unknown id: ${id}`);
    }
  }
  return tasks;
}

// A min-heap makes the next ready task independent of input order.
class ReadyQueue {
  private values: string[] = [];

  push(value: string): void {
    const values = this.values;
    let index = values.length;
    values.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (values[parent]! <= value) break;
      values[index] = values[parent]!;
      index = parent;
    }
    values[index] = value;
  }

  pop(): string | undefined {
    const values = this.values;
    if (!values.length) return undefined;
    const first = values[0]!;
    const last = values.pop()!;
    if (values.length) {
      let index = 0;
      while (index * 2 + 1 < values.length) {
        let child = index * 2 + 1;
        if (child + 1 < values.length && values[child + 1]! < values[child]!) child++;
        if (last <= values[child]!) break;
        values[index] = values[child]!;
        index = child;
      }
      values[index] = last;
    }
    return first;
  }
}

// Persistent paths avoid copying the full chain at every step of a long DAG.
interface Path { id: string; previous?: Path }

function sequence(path: Path): string[] {
  const ids: string[] = [];
  for (let cursor: Path | undefined = path; cursor; cursor = cursor.previous) ids.push(cursor.id);
  return ids.reverse();
}

function less(left: Path, right: Path): boolean {
  const a = sequence(left);
  const b = sequence(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! < b[index]!;
  }
  return a.length < b.length;
}

// Iterative DFS avoids recursion limits. Roots and dependency edges are sorted.
function findCycle(tasks: Map<string, Task>): string[] {
  const state = new Map<string, number>();
  for (const root of [...tasks.keys()].sort()) {
    if (state.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    state.set(root, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const edges = tasks.get(frame.id)!.dependsOn;
      if (frame.next === edges.length) {
        state.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const id = edges[frame.next++]!;
      if (state.get(id) === 1) {
        const start = stack.findIndex(item => item.id === id);
        return [...stack.slice(start).map(item => item.id), id];
      }
      if (!state.has(id)) {
        state.set(id, 1);
        stack.push({ id, next: 0 });
      }
    }
  }
  throw new Error("Internal error: expected a cycle");
}

export function plan(input: unknown): Plan {
  const tasks = new Map(validate(input).map(task => [task.id, task]));
  const remaining = new Map<string, number>();
  const children = new Map<string, string[]>();
  const ready = new ReadyQueue();
  for (const task of tasks.values()) {
    remaining.set(task.id, task.dependsOn.length);
    if (!task.dependsOn.length) ready.push(task.id);
    for (const dependency of task.dependsOn) {
      if (!children.has(dependency)) children.set(dependency, []);
      children.get(dependency)!.push(task.id);
    }
  }
  const order: string[] = [];
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    order.push(id);
    for (const child of children.get(id) ?? []) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (!count) ready.push(child);
    }
  }
  if (order.length !== tasks.size) throw new Error(`Cycle detected: ${findCycle(tasks).join(" -> ")}`);

  const earliest: Plan["earliest"] = Object.create(null);
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const paths = new Map<string, Path>();
  let totalDuration = 0;
  let critical: Path | undefined;
  for (const id of order) {
    const task = tasks.get(id)!;
    let start = 0;
    let level = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency]!.finish);
      level = Math.max(level, levels.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration exceeds the finite number range at task ${id}`);
    earliest[id] = { start, finish };
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    let best: Path | undefined = start === 0 ? { id } : undefined;
    for (const dependency of task.dependsOn) {
      if (earliest[dependency]!.finish !== start) continue;
      const candidate: Path = { id, previous: paths.get(dependency)! };
      // Compare full sequences, including the current id: prefix ties matter.
      if (!best || less(candidate, best)) best = candidate;
    }
    paths.set(id, best!);
    if (!critical || finish > totalDuration || (finish === totalDuration && less(best!, critical))) {
      totalDuration = finish;
      critical = best;
    }
  }
  for (const layer of layers) layer.sort();
  return { order, layers, earliest, totalDuration, criticalPath: critical ? sequence(critical) : [] };
}
