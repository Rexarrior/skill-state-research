import path from "node:path"

export const manifestFile = "experiments/context-redaction/artifact-manifest.json"
export const editorialFiles = ["articles/skill-state-in-coding-agents.md", "articles/README.md"]

export type ArtifactManifest = {
  version: 1
  files: Record<string, {
    sha256: string
    bytes: number
    reason: string
    historical: { sha256: string; bytes?: number; manifest: string }[]
  }>
}

export async function artifactDigest(file: string) {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  return { sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), bytes: bytes.length }
}

export async function loadArtifactIntegrity(root: string) {
  const manifest: ArtifactManifest = await Bun.file(path.join(root, manifestFile)).json()
  if (manifest.version !== 1) throw new Error("Unsupported cleaned-artifact manifest")
  const location = (file: string) => {
    const full = path.resolve(root, file)
    if (!full.startsWith(root + path.sep) || path.isAbsolute(file)) throw new Error("Invalid artifact path")
    return full
  }
  const check = async (file: string) => {
    const expected = manifest.files[file]
    if (!expected) throw new Error(`Artifact is not covered by the cleaned manifest: ${file}`)
    const actual = await artifactDigest(location(file))
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
      throw new Error(`Cleaned artifact changed: ${file}`)
  }
  return {
    async verify(file: string, historicalSha256: string, historicalBytes?: number) {
      if (editorialFiles.includes(file)) return
      const expected = manifest.files[file]
      if (!expected?.historical.some(h => h.sha256 === historicalSha256 &&
          (historicalBytes === undefined || h.bytes === historicalBytes)))
        throw new Error(`Unrecognized historical fingerprint: ${file}`)
      await check(file)
    },
    async verifyAll() {
      for (const file of Object.keys(manifest.files)) await check(file)
      return Object.keys(manifest.files).length
    },
  }
}

export async function verifyRecordedBinary(file: string, sha256: string) {
  if (file.includes("<nda context deleted,"))
    return { status: "not-rechecked", reason: "The historical host path was redacted.", sha256 }
  if (!await Bun.file(file).exists())
    return { status: "not-rechecked", reason: "The historical executable is unavailable on this host.", sha256 }
  if ((await artifactDigest(file)).sha256 !== sha256) throw new Error("Historical executable fingerprint differs")
  return { status: "verified", sha256 }
}

export function verificationOutput(root: string, name: string) {
  return path.join(root, "experiments/context-redaction/verification", name + ".json")
}
