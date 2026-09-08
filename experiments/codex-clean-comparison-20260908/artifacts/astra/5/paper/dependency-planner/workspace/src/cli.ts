type Task = { id: string; duration: number; dependsOn: string[] };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function parse(value: unknown): Task[] {
  const object = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!object(value) || !Array.isArray(value.tasks)) throw new Error("tasks must be an array");
  const ids = new Set<string>();
  const tasks = value.tasks.map((raw, index): Task => {
    if (!object(raw)) throw new Error(`tasks[${index}] must be an object`);
    const { id, duration } = raw;
    if (typeof id !== "string" || id.length === 0) throw new Error(`tasks[${index}].id must be a non-empty string`);
    if (ids.has(id)) throw new Error(`duplicate task id: ${id}`);
    ids.add(id);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)
      throw new Error(`task ${id}: duration must be a finite non-negative number`);
    const deps = raw.dependsOn === undefined ? [] : raw.dependsOn;
    if (!Array.isArray(deps) || deps.some(d => typeof d !== "string"))
      throw new Error(`task ${id}: dependsOn must be an array of strings`);
    if (new Set(deps).size !== deps.length) throw new Error(`task ${id}: duplicate dependency`);
    if (deps.includes(id)) throw new Error(`task ${id}: self dependency is forbidden (${id} -> ${id})`);
    return { id, duration, dependsOn: [...deps].sort(compare) };
  });
  for (const task of tasks) for (const dep of task.dependsOn)
    if (!ids.has(dep)) throw new Error(`task ${task.id}: unknown dependency ${dep}`);
  return tasks.sort((a, b) => compare(a.id, b.id));
}

function cycle(ids: string[], children: Map<string, string[]>): string[] {
  const color = new Map<string, number>();
  const path: string[] = [];
  const positions = new Map<string, number>();
  for (const root of ids) {
    if (color.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    color.set(root, 1); positions.set(root, 0); path.push(root);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = children.get(frame.id)!;
      if (frame.next === next.length) {
        color.set(frame.id, 2); positions.delete(frame.id); path.pop(); stack.pop();
        continue;
      }
      const id = next[frame.next++];
      if (color.get(id) === 1) return [...path.slice(positions.get(id)!), id];
      if (color.has(id)) continue;
      color.set(id, 1); positions.set(id, path.length); path.push(id);
      stack.push({ id, next: 0 });
    }
  }
  throw new Error("internal error: cycle not found");
}

// A min-heap keeps global ready-task selection O(log n).
class Ready {
  values: string[] = [];
  push(id: string) {
    let i = this.values.length;
    this.values.push(id);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(this.values[parent], id) <= 0) break;
      this.values[i] = this.values[parent]; i = parent;
    }
    this.values[i] = id;
  }
  pop(): string | undefined {
    if (!this.values.length) return undefined;
    const result = this.values[0], last = this.values.pop()!;
    if (this.values.length) {
      let i = 0;
      while (2 * i + 1 < this.values.length) {
        let child = 2 * i + 1;
        if (child + 1 < this.values.length && compare(this.values[child + 1], this.values[child]) < 0) child++;
        if (compare(last, this.values[child]) <= 0) break;
        this.values[i] = this.values[child]; i = child;
      }
      this.values[i] = last;
    }
    return result;
  }
}

function plan(tasks: Task[]) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map(tasks.map(task => [task.id, [] as string[]]));
  const pending = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  const ready = new Ready();
  for (const task of tasks) {
    if (!task.dependsOn.length) ready.push(task.id);
    for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  }
  const order: string[] = [];
  const layers: string[][] = [];
  const depth = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
  let totalDuration = 0;
  while (ready.values.length) {
    const id = ready.pop()!, task = byId.get(id)!;
    let start = 0, level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      level = Math.max(level, depth.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`duration overflow at task ${id}`);
    earliest[id] = { start, finish }; totalDuration = Math.max(totalDuration, finish);
    depth.set(id, level); (layers[level] ??= []).push(id); order.push(id);
    for (const child of children.get(id)!) {
      const count = pending.get(child)! - 1; pending.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  if (order.length !== tasks.length) throw new Error(`cycle detected: ${cycle(tasks.map(t => t.id), children).join(" -> ")}`);
  for (const layer of layers) layer.sort(compare);

  // Mark edges on a longest path using forward finish times. Reverse reachability
  // lets us choose the smallest full sequence without prefix-tie DP mistakes.
  const viable = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (earliest[id].finish === totalDuration || children.get(id)!.some(child =>
      viable.has(child) && earliest[id].finish === earliest[child].start)) viable.add(id);
  }
  const criticalPath: string[] = [];
  let current = tasks.find(task => viable.has(task.id) && earliest[task.id].start === 0)?.id;
  while (current !== undefined) {
    criticalPath.push(current);
    if (earliest[current].finish === totalDuration) break;
    const finish = earliest[current].finish;
    current = children.get(current)!.find(child => viable.has(child) && earliest[child].start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-"))
    throw new Error("usage: bun run src/cli.ts plan INPUT.json (unknown commands and flags are not supported)");
  let value: unknown;
  try { value = JSON.parse(await Bun.file(args[1]).text()); }
  catch (error) { throw new Error(`cannot read/parse JSON ${args[1]}: ${error instanceof Error ? error.message : String(error)}`); }
  console.log(JSON.stringify(plan(parse(value))));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
