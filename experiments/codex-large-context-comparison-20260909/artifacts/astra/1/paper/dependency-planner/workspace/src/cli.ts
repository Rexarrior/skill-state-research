export type Task = { id: string; duration: number; dependsOn: string[] };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function validate(input: unknown): Task[] {
  if (!object(input) || !Array.isArray(input.tasks)) throw new Error("Input must contain a tasks array");
  const ids = new Set<string>();
  const tasks = input.tasks.map((value, index) => {
    if (!object(value)) throw new Error(`tasks[${index}] must be an object`);
    const { id, duration } = value;
    if (typeof id !== "string" || id.length === 0) throw new Error(`tasks[${index}].id must be a non-empty string`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
    ids.add(id);
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) throw new Error(`Task ${id}: duration must be finite and non-negative`);
    const dependsOn = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== "string")) throw new Error(`Task ${id}: dependsOn must be an array of strings`);
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Task ${id}: duplicate dependency`);
    if (dependsOn.includes(id)) throw new Error(`Task ${id}: cannot depend on itself (${id} -> ${id})`);
    return { id, duration, dependsOn: [...dependsOn].sort(compare) } as Task;
  });
  for (const task of tasks) for (const dep of task.dependsOn) {
    if (!ids.has(dep)) throw new Error(`Task ${task.id}: unknown dependency ${dep}`);
  }
  return tasks;
}

function cycle(tasks: Map<string, Task>): string[] {
  const colors = new Map<string, number>();
  for (const root of [...tasks.keys()].sort(compare)) {
    if (colors.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    colors.set(root, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const deps = tasks.get(frame.id)!.dependsOn;
      if (frame.next === deps.length) {
        colors.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const dep = deps[frame.next++];
      if (colors.get(dep) === 1) {
        return [...stack.slice(stack.findIndex(item => item.id === dep)).map(item => item.id), dep];
      }
      if (!colors.has(dep)) {
        colors.set(dep, 1);
        stack.push({ id: dep, next: 0 });
      }
    }
  }
  return [];
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const remaining = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  const children = new Map(tasks.map(task => [task.id, [] as string[]]));
  for (const task of tasks) for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  for (const list of children.values()) list.sort(compare);
  const ready = tasks.filter(task => !task.dependsOn.length).map(task => task.id).sort(compare);
  const order: string[] = [];
  const layers: string[][] = [];
  const levels = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
  let totalDuration = 0;
  while (ready.length) {
    const id = ready.shift()!;
    const task = byId.get(id)!;
    let start = 0, level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      level = Math.max(level, levels.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Task ${id}: schedule duration exceeds finite number range`);
    earliest[id] = { start, finish };
    levels.set(id, level);
    (layers[level] ??= []).push(id);
    totalDuration = Math.max(totalDuration, finish);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) {
        // Binary insertion preserves lexicographic priority across newly ready tasks.
        let low = 0, high = ready.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (compare(ready[middle], child) < 0) low = middle + 1;
          else high = middle;
        }
        ready.splice(low, 0, child);
      }
    }
  }
  if (order.length !== tasks.length) throw new Error(`Cycle detected: ${cycle(byId).join(" -> ")}`);
  for (const layer of layers) layer.sort(compare);

  // Tight edges form all maximum-duration chains. Working backwards preserves
  // full-sequence tie-breaking even when a zero-duration prefix changes it.
  const reachesEnd = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (earliest[id].finish === totalDuration || children.get(id)!.some(child =>
      reachesEnd.has(child) && earliest[id].finish === earliest[child].start)) reachesEnd.add(id);
  }
  const criticalPath: string[] = [];
  let current = [...byId.keys()].sort(compare).find(id => earliest[id].start === 0 && reachesEnd.has(id));
  while (current !== undefined) {
    criticalPath.push(current);
    // A sequence precedes all of its strict extensions.
    if (earliest[current].finish === totalDuration) break;
    const finish = earliest[current].finish;
    current = children.get(current)!.find(child => reachesEnd.has(child) && earliest[child].start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
      throw new Error("Usage: bun run src/cli.ts plan INPUT.json (no flags supported)");
    }
    const text = await Bun.file(args[1]).text();
    let input: unknown;
    try { input = JSON.parse(text); } catch { throw new Error("Invalid JSON in input file"); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
