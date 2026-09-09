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

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
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
    if (dependencies.includes(value.id)) throw new Error(`Task ${JSON.stringify(value.id)} cannot depend on itself`);
    return { id: value.id, duration: value.duration, dependsOn: [...dependencies].sort(compare) };
  });
  for (const task of tasks) {
    for (const id of task.dependsOn) {
      if (!ids.has(id)) throw new Error(`Task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(id)}`);
    }
  }
  return tasks;
}

// A min-heap selects the smallest currently ready id, including newly ready tasks.
class ReadyQueue {
  private values: string[] = [];
  push(value: string) {
    const values = this.values;
    let i = values.length;
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(values[parent], value) <= 0) break;
      values[i] = values[parent];
      i = parent;
    }
    values[i] = value;
  }
  pop(): string | undefined {
    const values = this.values;
    if (!values.length) return undefined;
    const result = values[0];
    const last = values.pop()!;
    if (values.length) {
      let i = 0;
      while (2 * i + 1 < values.length) {
        let child = 2 * i + 1;
        if (child + 1 < values.length && compare(values[child + 1], values[child]) < 0) child++;
        if (compare(last, values[child]) <= 0) break;
        values[i] = values[child];
        i = child;
      }
      values[i] = last;
    }
    return result;
  }
}

// Iterative DFS avoids recursion limits. Edges point from prerequisites to dependents.
function findCycle(ids: string[], children: Map<string, string[]>): string[] {
  const colors = new Map<string, number>();
  const active = new Map<string, number>();
  for (const root of ids) {
    if (colors.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    colors.set(root, 1);
    active.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edges = children.get(frame.id)!;
      if (frame.next === edges.length) {
        colors.set(frame.id, 2);
        active.delete(frame.id);
        stack.pop();
        continue;
      }
      const next = edges[frame.next++];
      if (colors.get(next) === 1) {
        return [...stack.slice(active.get(next)!).map(item => item.id), next];
      }
      if (!colors.has(next)) {
        colors.set(next, 1);
        active.set(next, stack.length);
        stack.push({ id: next, next: 0 });
      }
    }
  }
  throw new Error("Internal error: cycle not found");
}

export function plan(input: unknown): Plan {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ids = [...byId.keys()].sort(compare);
  const children = new Map(ids.map(id => [id, [] as string[]]));
  const pending = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  for (const edges of children.values()) edges.sort(compare);
  const ready = new ReadyQueue();
  for (const id of ids) if (pending.get(id) === 0) ready.push(id);
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
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      level = Math.max(level, levels.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error("Schedule duration exceeds the finite number range");
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
  if (order.length !== tasks.length) {
    throw new Error(`Cycle detected: ${findCycle(ids, children).join(" -> ")}`);
  }
  for (const layer of layers) layer.sort(compare);

  // Mark tasks on a maximum-duration chain, then choose the smallest possible
  // next id. Stop as soon as the total is reached: a prefix sorts before extensions.
  const reachesEnd = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const current = order[i];
    if (earliest[current].finish === totalDuration || children.get(current)!.some(child =>
      reachesEnd.has(child) && earliest[current].finish === earliest[child].start)) {
      reachesEnd.add(current);
    }
  }
  const criticalPath: string[] = [];
  let current = ids.find(candidate => earliest[candidate].start === 0 && reachesEnd.has(candidate));
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current].finish === totalDuration) break;
    current = children.get(current)!.find(child => reachesEnd.has(child) && earliest[child].start === earliest[current!].finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}
