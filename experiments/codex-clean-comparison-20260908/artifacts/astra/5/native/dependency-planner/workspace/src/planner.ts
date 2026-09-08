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
    throw new Error("Input must be an object with a tasks array");
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
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Task ${task.id} references unknown dependency: ${dependency}`);
    }
  }
  return tasks;
}

// A min-heap keeps each ready-task selection lexicographic without re-sorting.
class ReadyQueue {
  private items: string[] = [];
  push(id: string): void {
    let index = this.items.length;
    this.items.push(id);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent] <= id) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = id;
  }
  pop(): string | undefined {
    if (!this.items.length) return undefined;
    const result = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length) {
      let index = 0;
      while (index * 2 + 1 < this.items.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1] < this.items[child]) child++;
        if (last <= this.items[child]) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return result;
  }
}

function findCycle(tasks: Map<string, Task>): string[] {
  const state = new Map<string, number>();
  const positions = new Map<string, number>();
  // Iterative DFS also handles chains deeper than the JavaScript call stack.
  for (const root of [...tasks.keys()].sort()) {
    if (state.has(root)) continue;
    const stack = [{ id: root, edge: 0 }];
    state.set(root, 1);
    positions.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const dependencies = tasks.get(frame.id)!.dependsOn;
      if (frame.edge === dependencies.length) {
        state.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
        continue;
      }
      const next = dependencies[frame.edge++];
      if (state.get(next) === 1) {
        return [...stack.slice(positions.get(next)!).map(frame => frame.id), next];
      }
      if (!state.has(next)) {
        positions.set(next, stack.length);
        state.set(next, 1);
        stack.push({ id: next, edge: 0 });
      }
    }
  }
  throw new Error("Unable to locate cycle");
}

export function plan(input: unknown): Plan {
  const tasks = new Map(validate(input).map(task => [task.id, task]));
  const children = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  const ready = new ReadyQueue();
  for (const task of tasks.values()) children.set(task.id, []);
  for (const task of tasks.values()) {
    remaining.set(task.id, task.dependsOn.length);
    if (!task.dependsOn.length) ready.push(task.id);
    for (const dependency of task.dependsOn) children.get(dependency)!.push(task.id);
  }
  const order: string[] = [];
  let id: string | undefined;
  while ((id = ready.pop()) !== undefined) {
    order.push(id);
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (!count) ready.push(child);
    }
  }
  if (order.length !== tasks.size) throw new Error(`Cycle detected: ${findCycle(tasks).join(" -> ")}`);

  const earliest: Plan["earliest"] = Object.create(null);
  const ranks = new Map<string, number>();
  const layers: string[][] = [];
  let totalDuration = 0;
  for (const id of order) {
    const task = tasks.get(id)!;
    let start = 0;
    let rank = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency].finish);
      rank = Math.max(rank, ranks.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration exceeds the finite number range at task ${id}`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    ranks.set(id, rank);
    (layers[rank] ??= []).push(id);
  }
  for (const layer of layers) layer.sort();

  // Work backwards over tight scheduling edges. A suffix can stop at any
  // task finishing at the makespan; shorter equal prefixes sort first.
  // Choosing prefixes locally would fail when zero-duration tasks extend them.
  const reachesEnd = new Set<string>();
  const nextOnPath = new Map<string, string>();
  for (let index = order.length - 1; index >= 0; index--) {
    const id = order[index];
    if (earliest[id].finish === totalDuration) {
      reachesEnd.add(id);
      continue;
    }
    let next: string | undefined;
    for (const child of children.get(id)!) {
      if (earliest[id].finish === earliest[child].start && reachesEnd.has(child)) {
        if (next === undefined || child < next) next = child;
      }
    }
    if (next !== undefined) {
      reachesEnd.add(id);
      nextOnPath.set(id, next);
    }
  }
  let first: string | undefined;
  for (const id of order) {
    if (earliest[id].start === 0 && reachesEnd.has(id) && (first === undefined || id < first)) first = id;
  }
  const criticalPath: string[] = [];
  while (first !== undefined) {
    criticalPath.push(first);
    first = nextOnPath.get(first);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}
