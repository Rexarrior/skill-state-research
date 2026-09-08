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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateInput(input: unknown): Task[] {
  if (!isObject(input) || !Array.isArray(input.tasks)) {
    throw new Error('Input must be an object with a "tasks" array.');
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    const label = `tasks[${index}]`;
    if (!isObject(value)) throw new Error(`${label} must be an object.`);
    if (typeof value.id !== "string" || value.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string.`);
    }
    if (ids.has(value.id)) throw new Error(`Duplicate task id ${JSON.stringify(value.id)}.`);
    ids.add(value.id);
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number.`);
    }
    const dependencies = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependencies) || dependencies.some((id) => typeof id !== "string")) {
      throw new Error(`${label}.dependsOn must be an array of strings.`);
    }
    if (new Set(dependencies).size !== dependencies.length) {
      throw new Error(`${label}.dependsOn contains duplicate ids.`);
    }
    if (dependencies.includes(value.id)) {
      throw new Error(`Task ${JSON.stringify(value.id)} cannot depend on itself.`);
    }
    return { id: value.id, duration: value.duration, dependsOn: [...dependencies] };
  });
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new Error(`Task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dependency)}.`);
      }
    }
  }
  return tasks;
}

// String comparison uses JavaScript's locale-independent UTF-16 ordering.
class MinHeap {
  private values: string[] = [];

  push(value: string): void {
    let index = this.values.length;
    this.values.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.values[parent]! <= value) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): string | undefined {
    if (this.values.length === 0) return undefined;
    const first = this.values[0]!;
    const last = this.values.pop()!;
    if (this.values.length > 0) {
      let index = 0;
      while (index * 2 + 1 < this.values.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.values.length && this.values[child + 1]! < this.values[child]!) child++;
        if (last <= this.values[child]!) break;
        this.values[index] = this.values[child]!;
        index = child;
      }
      this.values[index] = last;
    }
    return first;
  }
}

function comparePaths(left: string[], right: string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return left.length - right.length;
}

// Iterative DFS avoids overflowing the call stack on long dependency chains.
function findCycle(tasks: Map<string, Task>): string[] {
  const state = new Map<string, number>();
  const positions = new Map<string, number>();
  const path: string[] = [];
  const stack: { id: string; dependencies: string[]; next: number }[] = [];
  const enter = (id: string) => {
    state.set(id, 1);
    positions.set(id, path.length);
    path.push(id);
    stack.push({ id, dependencies: [...tasks.get(id)!.dependsOn].sort(), next: 0 });
  };
  for (const id of [...tasks.keys()].sort()) {
    if (state.has(id)) continue;
    enter(id);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.next === frame.dependencies.length) {
        state.set(frame.id, 2);
        positions.delete(frame.id);
        path.pop();
        stack.pop();
        continue;
      }
      const dependency = frame.dependencies[frame.next++]!;
      if (state.get(dependency) === 1) {
        return [...path.slice(positions.get(dependency)!), dependency];
      }
      if (!state.has(dependency)) enter(dependency);
    }
  }
  throw new Error("Unable to locate cycle.");
}

export function createPlan(input: unknown): Plan {
  const validated = validateInput(input);
  const tasks = new Map(validated.map((task) => [task.id, task]));
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const ready = new MinHeap();
  for (const task of validated) {
    remaining.set(task.id, task.dependsOn.length);
    dependents.set(task.id, []);
    if (task.dependsOn.length === 0) ready.push(task.id);
  }
  for (const task of validated) {
    for (const dependency of task.dependsOn) dependents.get(dependency)!.push(task.id);
  }
  const order: string[] = [];
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    order.push(id);
    for (const dependent of dependents.get(id)!) {
      const count = remaining.get(dependent)! - 1;
      remaining.set(dependent, count);
      if (count === 0) ready.push(dependent);
    }
  }
  if (order.length !== tasks.size) {
    const cycle = findCycle(tasks);
    // Quote unusual ids so arrows and newlines in an id remain unambiguous.
    const display = cycle.map((id) => /^[a-zA-Z0-9_.-]+$/.test(id) ? id : JSON.stringify(id));
    throw new Error(`Dependency cycle: ${display.join(" -> ")}`);
  }

  const earliest: Plan["earliest"] = Object.create(null);
  const layers: string[][] = [];
  const ranks = new Map<string, number>();
  const paths = new Map<string, string[]>();
  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const task = tasks.get(id)!;
    let start = 0;
    let rank = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency]!.finish);
      rank = Math.max(rank, ranks.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) {
      throw new Error(`Schedule duration overflows the finite number range at task ${JSON.stringify(id)}.`);
    }
    earliest[id] = { start, finish };
    ranks.set(id, rank);
    (layers[rank] ??= []).push(id);

    // A chain can start here when all preceding work takes zero time.
    let best: string[] | undefined = start === 0 ? [id] : undefined;
    for (const dependency of task.dependsOn) {
      if (earliest[dependency]!.finish !== start) continue;
      const candidate = [...paths.get(dependency)!, id];
      if (best === undefined || comparePaths(candidate, best) < 0) best = candidate;
    }
    paths.set(id, best!);
    if (criticalPath.length === 0 || finish > totalDuration ||
        (finish === totalDuration && comparePaths(best!, criticalPath) < 0)) {
      totalDuration = finish;
      criticalPath = best!;
    }
  }
  for (const layer of layers) layer.sort();
  return { order, layers, earliest, totalDuration, criticalPath };
}
