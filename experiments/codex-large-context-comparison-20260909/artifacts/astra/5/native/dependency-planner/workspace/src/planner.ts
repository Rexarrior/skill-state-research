export type Task = { id: string; duration: number; dependsOn: string[] };
export type Plan = {
  order: string[];
  layers: string[][];
  earliest: Record<string, { start: number; finish: number }>;
  totalDuration: number;
  criticalPath: string[];
};

// Use code-unit ordering consistently, independent of the machine's locale.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePaths(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const result = compare(a[i], b[i]);
    if (result) return result;
  }
  return a.length - b.length;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validate(input: unknown): Task[] {
  if (!isObject(input) || !Array.isArray(input.tasks)) {
    throw new Error('Input must be an object with a "tasks" array');
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    if (!isObject(value)) throw new Error(`tasks[${index}] must be an object`);
    const { id, duration } = value;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`tasks[${index}].id must be a non-empty string`);
    }
    if (ids.has(id)) throw new Error(`Duplicate task id ${JSON.stringify(id)}`);
    ids.add(id);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`Task ${JSON.stringify(id)}: duration must be a finite non-negative number`);
    }
    const dependsOn = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== "string")) {
      throw new Error(`Task ${JSON.stringify(id)}: dependsOn must be an array of strings`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error(`Task ${JSON.stringify(id)}: dependsOn contains duplicates`);
    }
    if (dependsOn.includes(id)) throw new Error(`Task ${JSON.stringify(id)} cannot depend on itself`);
    return { id, duration, dependsOn: [...dependsOn].sort(compare) };
  });
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`Task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(dep)}`);
      }
    }
  }
  return tasks;
}

class MinHeap {
  private values: string[] = [];
  get size(): number { return this.values.length; }
  push(value: string): void {
    const items = this.values;
    let i = items.length;
    items.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(items[parent], value) <= 0) break;
      items[i] = items[parent];
      i = parent;
    }
    items[i] = value;
  }
  pop(): string {
    const items = this.values;
    const result = items[0];
    const last = items.pop()!;
    if (items.length) {
      let i = 0;
      while (2 * i + 1 < items.length) {
        let child = 2 * i + 1;
        if (child + 1 < items.length && compare(items[child + 1], items[child]) < 0) child++;
        if (compare(last, items[child]) <= 0) break;
        items[i] = items[child];
        i = child;
      }
      items[i] = last;
    }
    return result;
  }
}

// Iterative DFS avoids call-stack limits on long dependency chains.
function findCycle(tasks: Map<string, Task>): string[] {
  const state = new Map<string, number>();
  const position = new Map<string, number>();
  for (const root of [...tasks.keys()].sort(compare)) {
    if (state.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    state.set(root, 1);
    position.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const dependencies = tasks.get(frame.id)!.dependsOn;
      if (frame.next === dependencies.length) {
        state.set(frame.id, 2);
        position.delete(frame.id);
        stack.pop();
        continue;
      }
      const dep = dependencies[frame.next++];
      if (state.get(dep) === 1) {
        return [...stack.slice(position.get(dep)!).map(item => item.id), dep];
      }
      if (!state.has(dep)) {
        state.set(dep, 1);
        position.set(dep, stack.length);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  throw new Error("Unable to locate cycle");
}

export function plan(input: unknown): Plan {
  const tasks = new Map(validate(input).map(task => [task.id, task]));
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const ready = new MinHeap();
  for (const task of tasks.values()) {
    remaining.set(task.id, task.dependsOn.length);
    if (!task.dependsOn.length) ready.push(task.id);
    for (const dep of task.dependsOn) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(task.id);
    }
  }
  const order: string[] = [];
  while (ready.size) {
    const id = ready.pop();
    order.push(id);
    for (const child of dependents.get(id) ?? []) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== tasks.size) {
    throw new Error(`Dependency cycle: ${findCycle(tasks).join(" -> ")}`);
  }

  const layers: string[][] = [];
  const depths = new Map<string, number>();
  const earliest: Plan["earliest"] = Object.create(null);
  const paths = new Map<string, string[]>();
  let totalDuration = 0;
  let criticalPath: string[] = [];
  for (const id of order) {
    const task = tasks.get(id)!;
    let start = 0;
    let depth = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      depth = Math.max(depth, depths.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Duration overflow at task ${JSON.stringify(id)}`);
    earliest[id] = { start, finish };
    depths.set(id, depth);
    (layers[depth] ??= []).push(id);

    // A chain can begin here when preceding tasks contribute zero duration.
    let best: string[] | undefined = start === 0 ? [id] : undefined;
    for (const dep of task.dependsOn) {
      if (earliest[dep].finish !== start) continue;
      const candidate = [...paths.get(dep)!, id];
      if (!best || comparePaths(candidate, best) < 0) best = candidate;
    }
    paths.set(id, best!);
    if (finish > totalDuration || (finish === totalDuration &&
        (!criticalPath.length || comparePaths(best!, criticalPath) < 0))) {
      totalDuration = finish;
      criticalPath = best!;
    }
  }
  for (const layer of layers) layer.sort(compare);
  return { order, layers, earliest, totalDuration, criticalPath };
}
