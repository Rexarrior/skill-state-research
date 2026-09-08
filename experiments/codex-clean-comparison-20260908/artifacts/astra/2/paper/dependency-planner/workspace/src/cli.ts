type Task = { id: string; duration: number; dependsOn: string[] };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function validate(input: unknown): Task[] {
  if (!input || typeof input !== 'object' || !Array.isArray((input as any).tasks))
    throw new Error('Input must be an object with a tasks array');
  const ids = new Set<string>();
  const tasks = (input as any).tasks.map((value: any, index: number): Task => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Task ${index} must be an object`);
    const { id, duration } = value;
    if (typeof id !== 'string' || id.length === 0) throw new Error(`Task ${index} needs a non-empty string id`);
    if (ids.has(id)) throw new Error(`Duplicate task id: ${id}`);
    ids.add(id);
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)
      throw new Error(`Invalid duration for task ${id}: expected a finite non-negative number`);
    const dependsOn = value.dependsOn === undefined ? [] : value.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((id: unknown) => typeof id !== 'string'))
      throw new Error(`dependsOn for ${id} must be an array of strings`);
    if (new Set(dependsOn).size !== dependsOn.length) throw new Error(`Duplicate dependency for ${id}`);
    if (dependsOn.includes(id)) throw new Error(`Task ${id} cannot depend on itself (${id} -> ${id})`);
    return { id, duration, dependsOn: [...dependsOn].sort(compare) };
  });
  for (const task of tasks) for (const dep of task.dependsOn)
    if (!ids.has(dep)) throw new Error(`Unknown dependency ${dep} for task ${task.id}`);
  return tasks.sort((a: Task, b: Task) => compare(a.id, b.id));
}

function cycle(tasks: Task[], byId: Map<string, Task>): string[] {
  const color = new Map<string, number>();
  for (const task of tasks) {
    if (color.has(task.id)) continue;
    const stack = [{ id: task.id, next: 0 }];
    const positions = new Map([[task.id, 0]]);
    color.set(task.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const deps = byId.get(frame.id)!.dependsOn;
      if (frame.next === deps.length) {
        color.set(frame.id, 2); positions.delete(frame.id); stack.pop(); continue;
      }
      const dep = deps[frame.next++];
      if (color.get(dep) === 1) return [...stack.slice(positions.get(dep)!).map(f => f.id), dep];
      if (!color.has(dep)) {
        positions.set(dep, stack.length); color.set(dep, 1); stack.push({ id: dep, next: 0 });
      }
    }
  }
  throw new Error('Unable to locate cycle');
}

function plan(tasks: Task[]) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const children = new Map(tasks.map(t => [t.id, [] as string[]]));
  const pending = new Map(tasks.map(t => [t.id, t.dependsOn.length]));
  for (const task of tasks) for (const dep of task.dependsOn) children.get(dep)!.push(task.id);
  const ready = tasks.filter(t => !t.dependsOn.length).map(t => t.id);
  const order: string[] = [];
  const layers: string[][] = [];
  const depth = new Map<string, number>();
  const earliest: Record<string, { start: number; finish: number }> = Object.create(null);
  let totalDuration = 0;
  while (ready.length) {
    const id = ready.shift()!;
    const task = byId.get(id)!;
    let start = 0, level = 0;
    for (const dep of task.dependsOn) {
      start = Math.max(start, earliest[dep].finish);
      level = Math.max(level, depth.get(dep)! + 1);
    }
    const finish = start + task.duration;
    if (!Number.isFinite(finish)) throw new Error('Schedule duration exceeds finite numeric range');
    earliest[id] = { start, finish };
    totalDuration = Math.max(totalDuration, finish);
    depth.set(id, level);
    (layers[level] ??= []).push(id);
    order.push(id);
    for (const child of children.get(id)!) {
      pending.set(child, pending.get(child)! - 1);
      if (pending.get(child) === 0) ready.push(child);
    }
    ready.sort(compare);
  }
  if (order.length !== tasks.length) throw new Error(`Dependency cycle: ${cycle(tasks, byId).join(' -> ')}`);
  for (const layer of layers) layer.sort(compare);

  // Mark edges belonging to a longest chain using the same forward sums as
  // earliest. This avoids comparing differently associated floating-point sums.
  const viable = new Set(order.filter(id => earliest[id].finish === totalDuration));
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (viable.has(id)) for (const dep of byId.get(id)!.dependsOn)
      if (earliest[dep].finish === earliest[id].start) viable.add(dep);
  }
  const criticalPath: string[] = [];
  let candidates = tasks.filter(t => viable.has(t.id) && earliest[t.id].start === 0).map(t => t.id);
  while (candidates.length) {
    const id = candidates.sort(compare)[0];
    criticalPath.push(id);
    // A sequence sorts before any longer sequence with the same prefix.
    if (earliest[id].finish === totalDuration) break;
    candidates = children.get(id)!.filter(child => viable.has(child) && earliest[child].start === earliest[id].finish);
  }
  return { order, layers, earliest, totalDuration, criticalPath };
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== 'plan' || args[1].startsWith('-'))
    throw new Error('Usage: bun run src/cli.ts plan INPUT.json (unknown commands and flags are not supported)');
  let input: unknown;
  const text = await Bun.file(args[1]).text();
  try { input = JSON.parse(text); } catch { throw new Error('Invalid JSON input'); }
  console.log(JSON.stringify(plan(validate(input))));
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
