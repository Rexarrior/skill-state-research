type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validate(input: unknown): Task[] {
  if (!record(input) || !Array.isArray(input.tasks)) throw new Error("Expected an object with a tasks array");
  const ids = new Set<string>();
  const tasks = input.tasks.map((value, index): Task => {
    const label = `tasks[${index}]`;
    if (!record(value)) throw new Error(`${label} must be an object`);
    if (typeof value.id !== "string" || value.id.length === 0) throw new Error(`${label}.id must be a non-empty string`);
    if (ids.has(value.id)) throw new Error(`Duplicate task id: ${value.id}`);
    ids.add(value.id);
    if (typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration < 0) {
      throw new Error(`${label}.duration must be a finite non-negative number`);
    }
    const deps = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(deps) || deps.some(dep => typeof dep !== "string")) throw new Error(`${label}.dependsOn must be an array of strings`);
    if (new Set(deps).size !== deps.length) throw new Error(`${label}.dependsOn contains duplicate ids`);
    if (deps.includes(value.id)) throw new Error(`Task ${value.id} cannot depend on itself (cycle: ${value.id} -> ${value.id})`);
    return { id: value.id, duration: value.duration, dependsOn: [...deps].sort(compare) };
  });
  for (const task of tasks) for (const dep of task.dependsOn) {
    if (!ids.has(dep)) throw new Error(`Task ${task.id} references unknown dependency: ${dep}`);
  }
  return tasks.sort((a, b) => compare(a.id, b.id));
}

// A min heap ensures that newly ready tasks compete with every waiting task.
class ReadyQueue {
  private values: string[] = [];
  push(value: string) {
    const a = this.values;
    let i = a.length;
    a.push(value);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compare(a[p]!, value) <= 0) break;
      a[i] = a[p]!;
      i = p;
    }
    a[i] = value;
  }
  pop(): string | undefined {
    const a = this.values;
    if (!a.length) return undefined;
    const result = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let child = i * 2 + 1;
        if (child + 1 < a.length && compare(a[child + 1]!, a[child]!) < 0) child++;
        if (compare(last, a[child]!) <= 0) break;
        a[i] = a[child]!;
        i = child;
      }
      a[i] = last;
    }
    return result;
  }
}

function cycle(tasks: Task[], byId: Map<string, Task>): string[] {
  const done = new Set<string>();
  const active = new Map<string, number>();
  // Explicit DFS frames avoid overflowing the call stack on long chains.
  for (const root of tasks) {
    if (done.has(root.id)) continue;
    const stack = [{ id: root.id, next: 0 }];
    active.set(root.id, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const deps = byId.get(frame.id)!.dependsOn;
      if (frame.next === deps.length) {
        done.add(frame.id);
        active.delete(frame.id);
        stack.pop();
        continue;
      }
      const dep = deps[frame.next++]!;
      const start = active.get(dep);
      if (start !== undefined) return [...stack.slice(start).map(f => f.id), dep];
      if (!done.has(dep)) {
        active.set(dep, stack.length);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  throw new Error("Internal error: cycle not found");
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const successors = new Map(tasks.map(task => [task.id, [] as string[]]));
  const indegree = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  const ready = new ReadyQueue();
  for (const task of tasks) {
    if (!task.dependsOn.length) ready.push(task.id);
    for (const dep of task.dependsOn) successors.get(dep)!.push(task.id);
  }
  const order: string[] = [];
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    order.push(id);
    for (const next of successors.get(id)!) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  if (order.length !== tasks.length) throw new Error(`Dependency cycle: ${cycle(tasks, byId).join(" -> ")}`);
  const timing = new Map<string, Timing>();
  const depth = new Map<string, number>();
  const layers: string[][] = [];
  let totalDuration = 0;
  for (const id of order) {
    const task = byId.get(id)!;
    let start = 0, layer = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, timing.get(dep)!.finish);
      layer = Math.max(layer, depth.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Schedule duration exceeds finite numeric range at task: ${id}`);
    timing.set(id, { start, finish });
    depth.set(id, layer);
    (layers[layer] ??= []).push(id);
    totalDuration = Math.max(totalDuration, finish);
  }
  for (const layer of layers) layer.sort(compare);

  // Mark tasks that can reach a maximum finish along timing-tight edges.
  // Choose the full chain from its start: comparing prefixes while building
  // paths backwards would break lexicographic ties around zero durations.
  const viable = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!;
    const finish = timing.get(id)!.finish;
    if (finish === totalDuration || successors.get(id)!.some(next => viable.has(next) && timing.get(next)!.start === finish)) viable.add(id);
  }
  const criticalPath: string[] = [];
  let current = tasks.find(task => timing.get(task.id)!.start === 0 && viable.has(task.id))?.id;
  while (current !== undefined) {
    criticalPath.push(current);
    const finish = timing.get(current)!.finish;
    // A sequence sorts before any longer sequence that has it as a prefix.
    if (finish === totalDuration) break;
    current = successors.get(current)!.find(next => viable.has(next) && timing.get(next)!.start === finish);
  }
  return {
    order, layers,
    earliest: Object.fromEntries(tasks.map(task => [task.id, timing.get(task.id)!])),
    totalDuration, criticalPath,
  };
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1]!.startsWith("-")) {
    throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
  }
  let text: string;
  try { text = await Bun.file(args[1]!).text(); }
  catch (error) { throw new Error(`Cannot read input file: ${error instanceof Error ? error.message : String(error)}`); }
  let input: unknown;
  try { input = JSON.parse(text); }
  catch (error) { throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  console.log(JSON.stringify(plan(input)));
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
