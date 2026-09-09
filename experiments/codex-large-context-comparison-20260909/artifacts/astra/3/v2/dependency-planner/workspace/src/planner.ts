export interface Task {
  id: string;
  duration: number;
  dependsOn: string[];
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function validate(input: unknown): Task[] {
  if (!record(input) || !Array.isArray(input.tasks)) throw new Error("Expected an object with a tasks array");
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    if (!record(value)) throw new Error(`tasks[${index}] must be an object`);
    const { id, duration } = value;
    if (typeof id !== "string" || id.length === 0) throw new Error(`tasks[${index}].id must be a non-empty string`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${JSON.stringify(id)}`);
    ids.add(id);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)
      throw new Error(`Task ${JSON.stringify(id)}: duration must be a finite non-negative number`);
    const dependsOn = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== "string"))
      throw new Error(`Task ${JSON.stringify(id)}: dependsOn must be an array of strings`);
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Task ${JSON.stringify(id)}: duplicate dependency`);
    if (dependsOn.includes(id)) throw new Error(`Task ${JSON.stringify(id)} cannot depend on itself`);
    return { id, duration, dependsOn: [...dependsOn] };
  });
  for (const task of tasks) for (const dep of task.dependsOn)
    if (!ids.has(dep)) throw new Error(`Task ${JSON.stringify(task.id)}: unknown dependency ${JSON.stringify(dep)}`);
  return tasks;
}

// A min heap ensures every newly ready task participates in the next choice.
class ReadyQueue {
  private items: string[] = [];
  push(id: string) {
    const a = this.items;
    let i = a.length;
    a.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(a[parent], id) <= 0) break;
      a[i] = a[parent];
      i = parent;
    }
    a[i] = id;
  }
  pop(): string | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const first = a[0], last = a.pop()!;
    if (a.length) {
      let i = 0;
      while (2 * i + 1 < a.length) {
        let child = 2 * i + 1;
        if (child + 1 < a.length && compare(a[child + 1], a[child]) < 0) child++;
        if (compare(last, a[child]) <= 0) break;
        a[i] = a[child];
        i = child;
      }
      a[i] = last;
    }
    return first;
  }
}

function findCycle(ids: string[], children: Map<string, string[]>): string[] {
  const color = new Map<string, number>();
  for (const root of ids) {
    if (color.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    const position = new Map([[root, 0]]);
    color.set(root, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = children.get(frame.id)![frame.next++];
      if (next === undefined) {
        color.set(frame.id, 2);
        position.delete(frame.id);
        stack.pop();
      } else if (color.get(next) === 1) {
        return [...stack.slice(position.get(next)!).map(f => f.id), next];
      } else if (!color.has(next)) {
        color.set(next, 1);
        position.set(next, stack.length);
        stack.push({ id: next, next: 0 });
      }
    }
  }
  throw new Error("Cycle detection failed");
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ids = [...byId.keys()].sort(compare);
  const children = new Map(ids.map(id => [id, [] as string[]]));
  const remaining = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  for (const list of children.values()) list.sort(compare);
  const ready = new ReadyQueue();
  for (const id of ids) if (remaining.get(id) === 0) ready.push(id);
  const order: string[] = [];
  const layers: string[][] = [];
  const depth = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
  let totalDuration = 0;
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    const task = byId.get(id)!;
    let start = 0, layer = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      layer = Math.max(layer, depth.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error("Schedule duration exceeds the finite numeric range");
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
  if (order.length !== tasks.length) throw new Error(`Cycle detected: ${findCycle(ids, children).join(" -> ")}`);
  for (const layer of layers) layer.sort(compare);

  // Mark nodes on a maximum-duration chain. Tight edges preserve earliest
  // times; reverse traversal finds which of them can reach the makespan.
  const reachesEnd = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (earliest[id].finish === totalDuration || children.get(id)!.some(child =>
      earliest[id].finish === earliest[child].start && reachesEnd.has(child))) reachesEnd.add(id);
  }
  const criticalPath: string[] = [];
  let current = ids.find(id => earliest[id].start === 0 && reachesEnd.has(id));
  while (current !== undefined) {
    criticalPath.push(current);
    // A sequence sorts before its proper extensions, even zero-cost ones.
    if (earliest[current].finish === totalDuration) break;
    const finish = earliest[current].finish;
    current = children.get(current)!.find(child => earliest[child].start === finish && reachesEnd.has(child));
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}
