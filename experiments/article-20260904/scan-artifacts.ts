import path from "node:path"
import { readdir } from "node:fs/promises"

// Heuristic pre-publication scan. Print locations/categories only, never candidate values.
const root = path.resolve(import.meta.dir, "../..")
const data = await Bun.file(path.join(import.meta.dir, "data.json")).json()
const patterns = [
  ["API-key-shaped string", /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/],
  ["bearer credential", /Bearer\s+[A-Za-z0-9._~+\/-]{24,}/i],
  ["GitHub credential", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,})/],
  ["OAuth-shaped string", /\b(?:y[01]_|t[01]_|AQAD-)[A-Za-z0-9_-]{30,}/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
] as const
const findings = []
let scanned = 0
let opaqueReasoningFieldsOmitted = 0
for (const folder of new Set(data.rows.map((r: any) => path.dirname(r.source)))) {
  const absolute = path.join(root, folder as string)
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(jsonl|json|log|md)$/.test(entry.name)) continue
    const file = path.join(absolute, entry.name)
    let text = await Bun.file(file).text()
    if (entry.name.endsWith(".jsonl")) text = text.split("\n").map((line) => {
      // Ciphertext can accidentally contain a credential-shaped substring. Do not decode it or
      // exclude the rest of the event/file: all plaintext instructions, arguments and outputs remain scanned.
      let event
      try { event = JSON.parse(line) } catch { return line }
      if (event.type !== "response_item" || event.payload?.type !== "reasoning" ||
          typeof event.payload.encrypted_content !== "string") return line
      event.payload.encrypted_content = "[opaque provider-encrypted reasoning field omitted from plaintext scan]"
      opaqueReasoningFieldsOmitted++
      return JSON.stringify(event)
    }).join("\n")
    scanned++
    for (const [category, pattern] of patterns) if (pattern.test(text))
      findings.push({ file: path.relative(root, file), category })
  }
}
await Bun.write(path.join(import.meta.dir, "artifact-scan.json"), JSON.stringify({
  partial: data.missing > 0, scanned, findings, opaqueReasoningFieldsOmitted,
  scope: "Top-level campaign-cell logs/summaries; heuristic plaintext patterns only. Provider response_item/reasoning encrypted_content fields are omitted without decoding or modifying source logs. This is not proof that all confidential information is absent and does not authorize publication.",
}, null, 2) + "\n")
console.log(JSON.stringify({ scanned, findings, opaqueReasoningFieldsOmitted }, null, 2))
if (findings.length) process.exitCode = 1
