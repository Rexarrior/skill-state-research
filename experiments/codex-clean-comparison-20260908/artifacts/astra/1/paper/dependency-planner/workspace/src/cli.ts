type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function validate(input: unknown): Task[] {
  if (!object(input) || !Array.isArray(input.tasks)) throw new Error('Input must contain a tasks array');
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    if (!object(value)) throw new Error(`tasks[${index}] must be an object`);
    const { id, duration } = value;
    if (typeof id !== 'string' || id.length === 0) throw new Error(`tasks[${index}].id must be a non-empty string`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
    ids.add(id);
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)
      throw new Error(`Task ${id}: duration must be a finite non-negative number`);
    const dependsOn = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== 'string'))
      throw new Error(`Task ${id}: dependsOn must be an array of unique strings`);
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Task ${id}: duplicate dependency`);
    if (dependsOn.includes(id)) throw new Error(`Task ${id}: self dependency is forbidden (${id} -> ${id})`);
    return { id, duration, dependsOn: [...dependsOn].sort(lexical) };
  });
  for (const task of tasks) for (const dep of task.dependsOn)
    if (!ids.has(dep)) throw new Error(`Task ${task.id}: unknown dependency ${dep}`);
  return tasks.sort((a, b) => lexical(a.id, b.id));
}

// Iterative DFS avoids call-stack limits and returns an actual directed cycle.
function findCycle(ids: string[], children: Map<string, string[]>): string[] {
  const color = new Map<string, number>();
  const positions = new Map<string, number>();
  for (const root of ids) {
    if (color.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    color.set(root, 1);
    positions.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edges = children.get(frame.id)!;
      if (frame.next === edges.length) {
        color.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
        continue;
      }
      const child = edges[frame.next++];
      if (color.get(child) === 1) return [...stack.slice(positions.get(child)!).map(x => x.id), child];
      if (!color.has(child)) {
        positions.set(child, stack.length);
        color.set(child, 1);
        stack.push({ id: child, next: 0 });
      }
    }
  }
  throw new Error('Cycle detection failed');
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map(tasks.map(task => [task.id, [] as string[]]));
  const remaining = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  const ready = tasks.filter(task => task.dependsOn.length === 0).map(task => task.id);
  const order: string[] = [];
  const layers: string[][] = [];
  const depths = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  let totalDuration = 0;
  while (ready.length) {
    const id = ready.shift()!;
    const task = byId.get(id)!;
    let start = 0, depth = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      depth = Math.max(depth, depths.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Task ${id}: accumulated duration exceeds finite numeric range`);
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    depths.set(id, depth);
    (layers[depth] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) {
        let low = 0, high = ready.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if (lexical(ready[mid], child) < 0) low = mid + 1;
          else high = mid;
        }
        ready.splice(low, 0, child);
      }
    }
  }
  if (order.length !== tasks.length)
    throw new Error(`Cycle detected: ${findCycle(tasks.map(task => task.id), children).join(' -> ')}`);
  for (const layer of layers) layer.sort(lexical);

  // Mark tight edges that can reach a maximum finish. Greedily choosing ids
  // then yields the smallest full sequence, even with zero-duration prefixes.
  const reachesEnd = new Set<string>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (earliest[id].finish === totalDuration || children.get(id)!.some(child =>
      reachesEnd.has(child) && earliest[id].finish === earliest[child].start)) reachesEnd.add(id);
  }
  const criticalPath: string[] = [];
  let current = tasks.find(task => earliest[task.id].start === 0 && reachesEnd.has(task.id))?.id;
  while (current !== undefined) {
    criticalPath.push(current);
    // A prefix sorts before any of its extensions.
    if (earliest[current].finish === totalDuration) break;
    const finish = earliest[current].finish;
    current = children.get(current)!.find(child => reachesEnd.has(child) && earliest[child].start === finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== 'plan' || args[1].startsWith('-'))
      throw new Error('Usage: bun run src/cli.ts plan INPUT.json (unknown commands and flags are not supported)');
    let input: unknown;
    const text = await Bun.file(args[1]).text();
    try { input = JSON.parse(text); }
    catch { throw new Error(`Invalid JSON in ${args[1]}`); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
