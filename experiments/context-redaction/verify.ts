import path from "node:path"
import { loadArtifactIntegrity, verificationOutput } from "../../scripts/artifact-integrity"

const root = path.resolve(import.meta.dir, "../..")
const integrity = await loadArtifactIntegrity(root)
const files = await integrity.verifyAll()
const result = { checkedAt: new Date().toISOString(), status: "passed", files,
  scope: "Exact SHA-256 and byte sizes of the cleaned snapshot; not a rerun of the benchmarks or a reconstruction of deleted context." }
await Bun.write(verificationOutput(root, "integrity"), JSON.stringify(result, null, 2) + "\n")
console.log(JSON.stringify(result))
