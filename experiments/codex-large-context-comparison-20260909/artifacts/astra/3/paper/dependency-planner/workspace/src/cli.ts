export type Task = { id: string; duration: number; dependsOn: string[] };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function validate(input: unknown): Task[] {
  if (!input || typeof input !== 'object' || !Array.isArray((input as any).tasks)) {
    throw new Error('Input must be an object with a tasks array');
  }
  const ids = new Set<string>();
  const tasks = (input as { tasks: unknown[] }).tasks.map((value, index): Task => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`tasks[${index}] must be an object`);
    const { id, duration, dependsOn = [] } = value as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0) throw new Error(`tasks[${index}].id must be a non-empty string`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
    ids.add(id);
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) throw new Error(`Task ${id}: duration must be a finite non-negative number`);
    if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== 'string')) throw new Error(`Task ${id}: dependsOn must be an array of strings`);
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Task ${id}: duplicate dependency`);
    if (dependsOn.includes(id)) throw new Error(`Task ${id}: self-dependency (${id} -> ${id})`);
    return { id, duration, dependsOn: [...dependsOn].sort(compare) };
  });
  for (const task of tasks) for (const dep of task.dependsOn) {
    if (!ids.has(dep)) throw new Error(`Task ${task.id}: unknown dependency ${dep}`);
  }
  return tasks;
}

// Iterative DFS avoids call-stack limits for long cycles. Traverse dependency
// edges in sorted order so both the chosen cycle and its orientation are stable.
function cycle(ids: string[], tasks: Map<string, Task>): string[] {
  const state = new Map<string, number>();
  const positions = new Map<string, number>();
  for (const root of ids) {
    if (state.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    state.set(root, 1);
    positions.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const deps = tasks.get(frame.id)!.dependsOn;
      if (frame.next === deps.length) {
        state.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
        continue;
      }
      const dep = deps[frame.next++];
      if (state.get(dep) === 1) return [...stack.slice(positions.get(dep)!).map(f => f.id), dep];
      if (!state.has(dep)) {
        state.set(dep, 1);
        positions.set(dep, stack.length);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  throw new Error('Internal error: cycle not found');
}

// A min-heap ensures newly ready tasks participate in the very next choice.
class Ready {
  private items: string[] = [];
  push(id: string) {
    let i = this.items.length;
    this.items.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(this.items[parent], id) <= 0) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = id;
  }
  pop(): string | undefined {
    if (!this.items.length) return undefined;
    const result = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length) {
      let i = 0;
      while (2 * i + 1 < this.items.length) {
        let child = 2 * i + 1;
        if (child + 1 < this.items.length && compare(this.items[child + 1], this.items[child]) < 0) child++;
        if (compare(last, this.items[child]) <= 0) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return result;
  }
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ids = [...byId.keys()].sort(compare);
  const successors = new Map(ids.map(id => [id, [] as string[]]));
  const remaining = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const id of ids) for (const dep of byId.get(id)!.dependsOn) successors.get(dep)!.push(id);
  const ready = new Ready();
  for (const id of ids) if (remaining.get(id) === 0) ready.push(id);
  const order: string[] = [];
  const layers: string[][] = [];
  const depth = new Map<string, number>();
  const times = new Map<string, { start: number; finish: number }>();
  let totalDuration = 0;
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    const task = byId.get(id)!;
    let start = 0, layer = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, times.get(dep)!.finish);
      layer = Math.max(layer, depth.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Task ${id}: schedule duration exceeds finite numeric range`);
    times.set(id, { start, finish });
    depth.set(id, layer);
    (layers[layer] ??= []).push(id);
    totalDuration = Math.max(totalDuration, finish);
    order.push(id);
    for (const next of successors.get(id)!) {
      const count = remaining.get(next)! - 1;
      remaining.set(next, count);
      if (!count) ready.push(next);
    }
  }
  if (order.length !== tasks.length) throw new Error(`Dependency cycle: ${cycle(ids, byId).join(' -> ')}`);
  for (const layer of layers) layer.sort(compare);

  // Mark tight-edge chains that can reach a maximum-finish task. Choosing
  // each next id greedily compares FULL sequences, even with zero durations.
  const reachesEnd = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const finish = times.get(id)!.finish;
    if (finish === totalDuration || successors.get(id)!.some(next => reachesEnd.has(next) && times.get(next)!.start === finish)) reachesEnd.add(id);
  }
  const criticalPath: string[] = [];
  let current = ids.find(id => times.get(id)!.start === 0 && reachesEnd.has(id));
  while (current !== undefined) {
    criticalPath.push(current);
    const finish = times.get(current)!.finish;
    if (finish === totalDuration) break; // A prefix sorts before its extensions.
    current = successors.get(current)!.find(next => reachesEnd.has(next) && times.get(next)!.start === finish);
  }
  const earliest = Object.fromEntries(ids.map(id => [id, times.get(id)!]));
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== 'plan' || args[1].startsWith('-')) throw new Error('Usage: bun run src/cli.ts plan INPUT.json (unknown commands and flags are not supported)');
    let input: unknown;
    const text = await Bun.file(args[1]).text();
    try { input = JSON.parse(text); } catch { throw new Error(`Invalid JSON in ${args[1]}`); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
