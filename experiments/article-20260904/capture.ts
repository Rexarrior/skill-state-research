import { createHash } from "node:crypto"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const files = [
  "opencode/packages/opencode/src/session/skill-state.ts",
  "opencode/packages/opencode/src/session/prompt.ts",
  "codex/codex-rs/core/src/skill_state.rs",
  "codex/codex-rs/core/src/skill_state_paper.rs",
  "codex/codex-rs/core/src/session/turn.rs",
  "codex/codex-rs/core/src/tools/parallel.rs",
  "experiments/skill-state/scripts/run.ts",
  "experiments/codex-skill-state/scripts/run.ts",
  "experiments/skill-state/scripts/evaluate.ts",
  "experiments/skill-state/prompts/one-shot.txt",
  ...["taskboard-cli", "csv-insights", "mini-template", "http-kv", "dependency-planner"].map(
    (project) => `experiments/skill-state/projects/${project}/SPEC.md`,
  ),
]
const hashes = Object.fromEntries(await Promise.all(files.map(async (file) => [
  file, createHash("sha256").update(new Uint8Array(await Bun.file(path.join(root, file)).arrayBuffer())).digest("hex"),
])))
const head = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe" })
const diff = Bun.spawn(["git", "diff", "--binary", "--", ...files], { cwd: root, stdout: "pipe" })
const patch = await new Response(diff.stdout).text()
if (await diff.exited !== 0 || await head.exited !== 0) throw new Error("Git capture failed")
await Bun.write(path.join(import.meta.dir, "source.patch"), patch)
await Bun.write(path.join(import.meta.dir, "source-manifest.json"), JSON.stringify({
  capturedAt: new Date().toISOString(),
  baseCommit: (await new Response(head.stdout).text()).trim(),
  patchSha256: createHash("sha256").update(patch).digest("hex"),
  files: hashes,
}, null, 2) + "\n")
console.log(`Captured ${files.length} source hashes and source.patch`)
