type Task = { id: string; duration: number; dependsOn: string[] };
type Timing = { start: number; finish: number };

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function comparePaths(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = compare(a[i], b[i]);
    if (difference) return difference;
  }
  return a.length - b.length;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validate(input: unknown): Task[] {
  if (!isObject(input) || !Array.isArray(input.tasks)) throw new Error('tasks must be an array');
  const ids = new Set<string>();
  const tasks = input.tasks.map((value: unknown, index: number): Task => {
    if (!isObject(value)) throw new Error(`tasks[${index}] must be an object`);
    const { id, duration } = value;
    if (typeof id !== 'string' || id.length === 0) throw new Error(`tasks[${index}].id must be a non-empty string`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
    ids.add(id);
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
      throw new Error(`Task ${id}: duration must be a finite non-negative number`);
    }
    const dependsOn = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some(dep => typeof dep !== 'string')) {
      throw new Error(`Task ${id}: dependsOn must be an array of strings`);
    }
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Task ${id}: duplicate dependency`);
    if (dependsOn.includes(id)) throw new Error(`Task ${id}: self-dependency is forbidden (${id} -> ${id})`);
    return { id, duration, dependsOn: [...dependsOn].sort(compare) };
  });
  for (const task of tasks) for (const dep of task.dependsOn) {
    if (!ids.has(dep)) throw new Error(`Task ${task.id}: unknown dependency ${dep}`);
  }
  return tasks;
}

// Iterative DFS avoids call-stack limits on long dependency chains.
function findCycle(ids: string[], children: Map<string, string[]>): string[] {
  const color = new Map<string, number>();
  for (const root of ids) {
    if (color.has(root)) continue;
    const stack = [{ id: root, next: 0 }];
    const positions = new Map([[root, 0]]);
    color.set(root, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const adjacent = children.get(frame.id)!;
      if (frame.next === adjacent.length) {
        color.set(frame.id, 2);
        positions.delete(frame.id);
        stack.pop();
        continue;
      }
      const next = adjacent[frame.next++];
      if (color.get(next) === 1) return [...stack.slice(positions.get(next)!).map(item => item.id), next];
      if (!color.has(next)) {
        color.set(next, 1);
        positions.set(next, stack.length);
        stack.push({ id: next, next: 0 });
      }
    }
  }
  throw new Error('Cycle detection failed');
}

export function plan(input: unknown) {
  const tasks = validate(input);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ids = [...byId.keys()].sort(compare);
  const children = new Map(ids.map(id => [id, [] as string[]]));
  const remaining = new Map(tasks.map(task => [task.id, task.dependsOn.length]));
  for (const task of tasks) for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  for (const adjacent of children.values()) adjacent.sort(compare);
  const ready = ids.filter(id => remaining.get(id) === 0);
  const order: string[] = [];
  const layers: string[][] = [];
  const depths = new Map<string, number>();
  const earliest: Record<string, Timing> = Object.create(null);
  const paths = new Map<string, string[]>();
  let totalDuration = 0;
  let criticalPath: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    const task = byId.get(id)!;
    order.push(id);
    let start = 0;
    let depth = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      depth = Math.max(depth, depths.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error(`Task ${id}: accumulated duration exceeds the finite numeric range`);
    earliest[id] = { start, finish };
    depths.set(id, depth);
    (layers[depth] ??= []).push(id);
    // A chain may begin here if preceding work contributes zero duration.
    let best: string[] | undefined = start === 0 ? [id] : undefined;
    for (const dep of task.dependsOn) {
      if (earliest[dep].finish !== start) continue;
      const candidate = [...paths.get(dep)!, id];
      if (!best || comparePaths(candidate, best) < 0) best = candidate;
    }
    paths.set(id, best!);
    if (finish > totalDuration || criticalPath.length === 0 || (finish === totalDuration && comparePaths(best!, criticalPath) < 0)) {
      totalDuration = finish;
      criticalPath = best!;
    }
    for (const child of children.get(id)!) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) {
        // Insert into the sorted ready queue, including newly ready tasks.
        let lo = 0, hi = ready.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (compare(ready[mid], child) < 0) lo = mid + 1;
          else hi = mid;
        }
        ready.splice(lo, 0, child);
      }
    }
  }
  if (order.length !== tasks.length) throw new Error(`Cycle detected: ${findCycle(ids, children).join(' -> ')}`);
  for (const layer of layers) layer.sort(compare);
  return { order, layers, earliest, totalDuration, criticalPath };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== 'plan' || args[1].startsWith('-')) {
      throw new Error('Usage: bun run src/cli.ts plan INPUT.json (unknown commands and flags are not supported)');
    }
    const text = await Bun.file(args[1]).text();
    let input: unknown;
    try { input = JSON.parse(text); }
    catch { throw new Error('Invalid JSON in input file'); }
    console.log(JSON.stringify(plan(input)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
