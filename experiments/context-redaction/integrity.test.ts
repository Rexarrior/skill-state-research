import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { artifactDigest, loadArtifactIntegrity, manifestFile, verifyRecordedBinary } from "../../scripts/artifact-integrity"

const temporary: string[] = []
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cleaned-artifact-test-"))
  temporary.push(root)
  await Bun.write(path.join(root, "result.json"), '{"tokens":123}')
  const digest = await artifactDigest(path.join(root, "result.json"))
  const historical = { sha256: "a".repeat(64), bytes: 99, manifest: "source-manifest.json" }
  await Bun.write(path.join(root, manifestFile), JSON.stringify({ version: 1, files: {
    "result.json": { ...digest, reason: "context-redaction", historical: [historical] },
  } }))
  return { root, historical, integrity: await loadArtifactIntegrity(root) }
}
test("accepts exact cleaned bytes with the recorded historical fingerprint", async () => {
  const { integrity, historical } = await fixture()
  await integrity.verify("result.json", historical.sha256, historical.bytes)
  expect(await integrity.verifyAll()).toBe(1)
})
test("rejects a same-size metric edit", async () => {
  const { root, integrity, historical } = await fixture()
  await Bun.write(path.join(root, "result.json"), '{"tokens":124}')
  await expect(integrity.verify("result.json", historical.sha256)).rejects.toThrow("Cleaned artifact changed")
})
test("rejects unknown historical hashes and sizes", async () => {
  const { integrity, historical } = await fixture()
  await expect(integrity.verify("result.json", "b".repeat(64))).rejects.toThrow("Unrecognized historical")
  await expect(integrity.verify("result.json", historical.sha256, 98)).rejects.toThrow("Unrecognized historical")
})
test("rejects missing files and unlisted artifacts", async () => {
  const { root, integrity } = await fixture()
  await expect(integrity.verify("unlisted.json", "a".repeat(64))).rejects.toThrow("Unrecognized historical")
  await rm(path.join(root, "result.json"))
  await expect(integrity.verifyAll()).rejects.toThrow()
})
test("leaves the explicitly excluded live article editable", async () => {
  const { integrity } = await fixture()
  await integrity.verify("articles/skill-state-in-coding-agents.md", "old-article-hash")
})
test("labels redacted executable paths as not rechecked", async () => {
  expect((await verifyRecordedBinary("<nda context deleted, size :10 chars>", "historical")).status).toBe("not-rechecked")
})
