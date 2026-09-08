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

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validate(input: unknown): Task[] {
  if (!object(input) || !Array.isArray(input.tasks)) {
    throw new Error('Input must be an object with a "tasks" array');
  }
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    const label = `tasks[${index}]`;
    if (!object(value)) throw new Error(`${label} must be an object`);
    if (typeof value.id !== "string" || value.id.length === 0) {
      throw new Error(`${label}.id must be a non-empty string`);
    }
    if (ids.has(value.id)) throw new Error(`Duplicate task id: ${value.id}`);
    ids.add(value.id);
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }
    const deps = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(deps) || deps.some((dep) => typeof dep !== "string")) {
      throw new Error(`${label}.dependsOn must be an array of strings`);
    }
    if (new Set(deps).size !== deps.length) throw new Error(`Duplicate dependency for ${value.id}`);
    if (deps.includes(value.id)) throw new Error(`Task ${value.id} cannot depend on itself`);
    return { id: value.id, duration: value.duration, dependsOn: [...deps].sort() };
  });
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) throw new Error(`Task ${task.id} references unknown dependency: ${dep}`);
    }
  }
  return tasks;
}

// A min-heap preserves lexical readiness order without repeatedly sorting the queue.
class ReadyQueue {
  private items: string[] = [];
  push(id: string): void {
    let index = this.items.length;
    this.items.push(id);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent]! <= id) break;
      this.items[index] = this.items[parent]!;
      index = parent;
    }
    this.items[index] = id;
  }
  pop(): string | undefined {
    if (this.items.length === 0) return undefined;
    const first = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length) {
      let index = 0;
      while (index * 2 + 1 < this.items.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1]! < this.items[child]!) child++;
        if (last <= this.items[child]!) break;
        this.items[index] = this.items[child]!;
        index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

function findCycle(tasks: Map<string, Task>): string[] {
  const state = new Map<string, number>();
  const positions = new Map<string, number>();
  // Iterative DFS also works on graphs deeper than the JavaScript call stack.
  for (const root of [...tasks.keys()].sort()) {
    if (state.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    state.set(root, 1);
    positions.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const dep = tasks.get(frame.id)!.dependsOn[frame.next++];
      if (dep === undefined) {
        state.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
      } else if (state.get(dep) === 1) {
        return [...stack.slice(positions.get(dep)!).map((entry) => entry.id), dep];
      } else if (!state.has(dep)) {
        positions.set(dep, stack.length);
        state.set(dep, 1);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  throw new Error("Unable to locate cycle");
}

export function plan(input: unknown): Plan {
  const tasks = new Map(validate(input).map((task) => [task.id, task]));
  const ids = [...tasks.keys()].sort();
  const children = new Map(ids.map((id) => [id, [] as string[]]));
  const remaining = new Map<string, number>();
  const ready = new ReadyQueue();
  for (const id of ids) {
    const task = tasks.get(id)!;
    remaining.set(id, task.dependsOn.length);
    if (!task.dependsOn.length) ready.push(id);
    for (const dep of task.dependsOn) children.get(dep)!.push(id);
  }
  const order: string[] = [];
  const layers: string[][] = [];
  const depth = new Map<string, number>();
  const earliest: Plan["earliest"] = Object.create(null);
  let totalDuration = 0;
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    const task = tasks.get(id)!;
    let start = 0;
    let layer = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep]!.finish);
      layer = Math.max(layer, depth.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration overflows for task ${id}`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    depth.set(id, layer);
    (layers[layer] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== tasks.size) throw new Error(`Cycle detected: ${findCycle(tasks).join(" -> ")}`);
  for (const layer of layers) layer.sort();

  // Mark nodes with a tight dependency chain to a maximum finish. Choosing
  // greedily from this set compares full sequences, including zero-time ties.
  const viable = new Set<string>();
  for (let index = order.length - 1; index >= 0; index--) {
    const id = order[index]!;
    if (earliest[id]!.finish === totalDuration || children.get(id)!.some((child) =>
      viable.has(child) && earliest[child]!.start === earliest[id]!.finish)) viable.add(id);
  }
  const criticalPath: string[] = [];
  let current = ids.find((id) => earliest[id]!.start === 0 && viable.has(id));
  while (current !== undefined) {
    criticalPath.push(current);
    const finish = earliest[current]!.finish;
    // A sequence sorts before any longer sequence having it as a prefix.
    if (finish === totalDuration) break;
    current = children.get(current)!.find((child) => viable.has(child) && earliest[child]!.start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}
