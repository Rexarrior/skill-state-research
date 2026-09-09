/** Dependency-free scheduling and command-line entry point for Bun. */
type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function validate(input: unknown): Task[] {
  if (!object(input) || !Array.isArray(input.tasks)) throw new Error("tasks must be an array");
  const ids = new Set<string>();
  const tasks = input.tasks.map((value, index): Task => {
    const label = `tasks[${index}]`;
    if (!object(value)) throw new Error(`${label} must be an object`);
    if (typeof value.id !== "string" || value.id.length === 0) throw new Error(`${label}.id must be a non-empty string`);
    if (ids.has(value.id)) throw new Error(`Duplicate task id: ${JSON.stringify(value.id)}`);
    ids.add(value.id);
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0)
      throw new Error(`${label}.duration must be a finite non-negative number`);
    const dependencies = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependencies) || dependencies.some(id => typeof id !== "string"))
      throw new Error(`${label}.dependsOn must be an array of strings`);
    if (new Set(dependencies).size !== dependencies.length) throw new Error(`${label}.dependsOn contains duplicates`);
    if (dependencies.includes(value.id)) throw new Error(`Task ${JSON.stringify(value.id)} cannot depend on itself`);
    return { id: value.id, duration: value.duration, dependsOn: [...dependencies].sort(compare) };
  });
  for (const task of tasks) for (const id of task.dependsOn)
    if (!ids.has(id)) throw new Error(`Task ${JSON.stringify(task.id)} references unknown dependency ${JSON.stringify(id)}`);
  return tasks;
}

// A min-heap makes the ready-task choice independent of input order.
class ReadyQueue {
  private items: string[] = [];
  push(id: string) {
    const items = this.items;
    let i = items.length;
    items.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(items[parent]!, id) <= 0) break;
      items[i] = items[parent]!;
      i = parent;
    }
    items[i] = id;
  }
  pop(): string | undefined {
    const items = this.items;
    if (!items.length) return undefined;
    const result = items[0]!;
    const last = items.pop()!;
    if (items.length) {
      let i = 0;
      while (i * 2 + 1 < items.length) {
        let child = i * 2 + 1;
        if (child + 1 < items.length && compare(items[child + 1]!, items[child]!) < 0) child++;
        if (compare(last, items[child]!) <= 0) break;
        items[i] = items[child]!;
        i = child;
      }
      items[i] = last;
    }
    return result;
  }
}

function cycle(tasks: Map<string, Task>, ids: string[]): string[] {
  const color = new Map<string, number>();
  for (const id of ids) {
    if (color.has(id)) continue;
    const stack = [{ id, next: 0 }];
    const position = new Map([[id, 0]]);
    color.set(id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const dependency = tasks.get(frame.id)!.dependsOn[frame.next++];
      if (dependency === undefined) {
        color.set(frame.id, 2);
        position.delete(frame.id);
        stack.pop();
      } else if (color.get(dependency) === 1) {
        return [...stack.slice(position.get(dependency)!).map(frame => frame.id), dependency];
      } else if (!color.has(dependency)) {
        color.set(dependency, 1);
        position.set(dependency, stack.length);
        stack.push({ id: dependency, next: 0 });
      }
    }
  }
  throw new Error("Unable to locate cycle");
}

export function plan(input: unknown) {
  const validated = validate(input);
  const tasks = new Map(validated.map(task => [task.id, task]));
  const ids = [...tasks.keys()].sort(compare);
  const successors = new Map(ids.map(id => [id, [] as string[]]));
  const remaining = new Map(ids.map(id => [id, tasks.get(id)!.dependsOn.length]));
  for (const id of ids) for (const dependency of tasks.get(id)!.dependsOn) successors.get(dependency)!.push(id);
  const ready = new ReadyQueue();
  for (const id of ids) if (remaining.get(id) === 0) ready.push(id);
  const order: string[] = [];
  const layers: string[][] = [];
  const depth = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  let totalDuration = 0;
  let id: string | undefined;
  while ((id = ready.pop()) !== undefined) {
    const task = tasks.get(id)!;
    let start = 0, layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency]!.finish);
      layer = Math.max(layer, depth.get(dependency)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration overflow at task ${JSON.stringify(id)}`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    depth.set(id, layer);
    (layers[layer] ??= []).push(id);
    order.push(id);
    for (const successor of successors.get(id)!) {
      const count = remaining.get(successor)! - 1;
      remaining.set(successor, count);
      if (count === 0) ready.push(successor);
    }
  }
  if (order.length !== ids.length) throw new Error(`Dependency cycle: ${cycle(tasks, ids).map(id => /[\r\n]/.test(id) ? JSON.stringify(id) : id).join(" -> ")}`);
  for (const layer of layers) layer.sort(compare);

  // Mark tasks that can reach a maximum finish through edges with no slack.
  // Choosing ids greedily then gives the smallest FULL sequence; retaining only
  // one best prefix per task would be incorrect for zero-duration prefixes.
  const critical = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const current = order[i]!;
    if (earliest[current]!.finish === totalDuration || successors.get(current)!.some(next =>
      critical.has(next) && earliest[current]!.finish === earliest[next]!.start)) critical.add(current);
  }
  const criticalPath: string[] = [];
  let current = ids.find(id => critical.has(id) && earliest[id]!.start === 0);
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current]!.finish === totalDuration) break; // A prefix sorts before its extensions.
    const finish = earliest[current]!.finish;
    current = successors.get(current)!.find(next => critical.has(next) && earliest[next]!.start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args[1]!.startsWith("-"))
      throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
    const text = await Bun.file(args[1]!).text();
    let input: unknown;
    try { input = JSON.parse(text); }
    catch (error) { throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
