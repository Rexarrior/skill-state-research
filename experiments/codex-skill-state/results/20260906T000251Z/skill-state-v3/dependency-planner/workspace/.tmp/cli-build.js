// @bun
// src/cli.ts
class CliError extends Error {
}
function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function describe(value) {
  if (value === null)
    return "null";
  if (Array.isArray(value))
    return "array";
  return typeof value;
}
function validateInput(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError(`input must be an object, got ${describe(value)}`);
  }
  const tasksValue = value.tasks;
  if (!Array.isArray(tasksValue)) {
    throw new CliError(`tasks must be an array, got ${describe(tasksValue)}`);
  }
  const tasks = [];
  const ids = new Set;
  for (let index = 0;index < tasksValue.length; index += 1) {
    const raw = tasksValue[index];
    const location = `tasks[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new CliError(`${location} must be an object, got ${describe(raw)}`);
    }
    const object = raw;
    const { id, duration } = object;
    if (typeof id !== "string" || id.length === 0) {
      throw new CliError(`${location}.id must be a non-empty string`);
    }
    if (ids.has(id)) {
      throw new CliError(`duplicate task id: ${JSON.stringify(id)}`);
    }
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      throw new CliError(`${location}.duration must be a finite non-negative number`);
    }
    const dependsOnValue = object.dependsOn ?? [];
    if (!Array.isArray(dependsOnValue)) {
      throw new CliError(`${location}.dependsOn must be an array of strings`);
    }
    const dependsOn = [];
    const dependencies = new Set;
    for (let dependencyIndex = 0;dependencyIndex < dependsOnValue.length; dependencyIndex += 1) {
      const dependency = dependsOnValue[dependencyIndex];
      if (typeof dependency !== "string") {
        throw new CliError(`${location}.dependsOn[${dependencyIndex}] must be a string`);
      }
      if (dependencies.has(dependency)) {
        throw new CliError(`${location}.dependsOn contains duplicate id ${JSON.stringify(dependency)}`);
      }
      dependencies.add(dependency);
      dependsOn.push(dependency);
    }
    ids.add(id);
    tasks.push({ id, duration, dependsOn });
  }
  for (let index = 0;index < tasks.length; index += 1) {
    const task = tasks[index];
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new CliError(`tasks[${index}].dependsOn cannot contain its own id ${JSON.stringify(task.id)}`);
      }
      if (!ids.has(dependency)) {
        throw new CliError(`tasks[${index}].dependsOn references unknown task ${JSON.stringify(dependency)}`);
      }
    }
  }
  return tasks;
}
function findCycle(tasksById) {
  const state = new Map;
  const stack = [];
  const stackIndex = new Map;
  function visit(id) {
    state.set(id, 1);
    stackIndex.set(id, stack.length);
    stack.push(id);
    const dependencies = [...tasksById.get(id).dependsOn].sort(compareIds);
    for (const dependency of dependencies) {
      const dependencyState = state.get(dependency) ?? 0;
      if (dependencyState === 0) {
        const cycle = visit(dependency);
        if (cycle !== null)
          return cycle;
      } else if (dependencyState === 1) {
        return [...stack.slice(stackIndex.get(dependency)), dependency];
      }
    }
    stack.pop();
    stackIndex.delete(id);
    state.set(id, 2);
    return null;
  }
  for (const id of [...tasksById.keys()].sort(compareIds)) {
    if ((state.get(id) ?? 0) === 0) {
      const cycle = visit(id);
      if (cycle !== null)
        return cycle;
    }
  }
  return null;
}
function comparePaths(left, right) {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0;index < sharedLength; index += 1) {
    const comparison = compareIds(left[index], right[index]);
    if (comparison !== 0)
      return comparison;
  }
  return left.length - right.length;
}
function insertSorted(values, value) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareIds(values[middle], value) < 0)
      low = middle + 1;
    else
      high = middle;
  }
  values.splice(low, 0, value);
}
function createPlan(tasks) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map;
  const remainingDependencies = new Map;
  for (const task of tasks) {
    dependents.set(task.id, []);
    remainingDependencies.set(task.id, task.dependsOn.length);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      dependents.get(dependency).push(task.id);
    }
  }
  for (const ids of dependents.values())
    ids.sort(compareIds);
  const ready = tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id).sort(compareIds);
  const order = [];
  while (ready.length > 0) {
    const id = ready.shift();
    order.push(id);
    for (const dependent of dependents.get(id)) {
      const count = remainingDependencies.get(dependent) - 1;
      remainingDependencies.set(dependent, count);
      if (count === 0)
        insertSorted(ready, dependent);
    }
  }
  if (order.length !== tasks.length) {
    const cycle = findCycle(tasksById);
    throw new CliError(`dependency cycle detected: ${cycle.join(" -> ")}`);
  }
  const earliest = Object.create(null);
  const layerById = new Map;
  const layers = [];
  const criticalPathById = new Map;
  for (const id of order) {
    const task = tasksById.get(id);
    let start = 0;
    let layer = 0;
    for (const dependency of task.dependsOn) {
      start = Math.max(start, earliest[dependency].finish);
      layer = Math.max(layer, layerById.get(dependency) + 1);
    }
    const candidateDependencies = task.dependsOn.filter((dependency) => earliest[dependency].finish === start).map((dependency) => criticalPathById.get(dependency)).sort(comparePaths);
    const path = candidateDependencies.length === 0 ? [id] : [...candidateDependencies[0], id];
    earliest[id] = { start, finish: start + task.duration };
    layerById.set(id, layer);
    criticalPathById.set(id, path);
    if (layers[layer] === undefined)
      layers[layer] = [];
    layers[layer].push(id);
  }
  for (const layer of layers)
    layer.sort(compareIds);
  const totalDuration = order.reduce((maximum, id) => Math.max(maximum, earliest[id].finish), 0);
  const criticalPath = order.filter((id) => earliest[id].finish === totalDuration).map((id) => criticalPathById.get(id)).sort(comparePaths)[0] ?? [];
  return { order, layers, earliest, totalDuration, criticalPath };
}
function usageError(args) {
  if (args.length === 0) {
    return new CliError("missing command; usage: bun run src/cli.ts plan INPUT.json");
  }
  if (args[0] !== "plan") {
    return new CliError(`unknown command ${JSON.stringify(args[0])}; expected "plan"`);
  }
  if (args.some((argument) => argument.startsWith("-"))) {
    const flag = args.find((argument) => argument.startsWith("-"));
    return new CliError(`unknown flag ${JSON.stringify(flag)}`);
  }
  return new CliError("usage: bun run src/cli.ts plan INPUT.json");
}
async function main() {
  const args = Bun.argv.slice(2);
  if (args.length !== 2 || args[0] !== "plan" || args[1].startsWith("-")) {
    throw usageError(args);
  }
  let text;
  try {
    text = await Bun.file(args[1]).text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`cannot read ${JSON.stringify(args[1])}: ${message}`);
  }
  let input;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`invalid JSON in ${JSON.stringify(args[1])}: ${message}`);
  }
  const plan = createPlan(validateInput(input));
  console.log(JSON.stringify(plan));
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
