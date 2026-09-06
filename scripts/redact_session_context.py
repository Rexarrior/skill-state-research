#!/usr/bin/env python3
"""Redact private host context without changing recorded numeric measurements.

Reference contents and names are loaded only into memory. Supply reference roots
and profile patterns locally; neither belongs in a committed configuration.
The marker counts Unicode characters in the original decoded text, not tokens.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
from collections import Counter
from functools import lru_cache
from pathlib import Path


MARKER = re.compile(r"<nda context deleted, size :\d+ chars>")
SKIP_DIRS = {".git", "node_modules", "target", ".venv", "__pycache__"}
OUTPUT_KEYS = {"output", "stdout", "stderr", "aggregated_output", "result", "preview"}


def marker(text):
    return f"<nda context deleted, size :{len(text)} chars>"


def git(root, *args, data=None):
    return subprocess.run(["git", "-C", str(root), *args], input=data,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout


def files_under(root):
    seen = set()
    for directory, dirs, files in os.walk(root, followlinks=True):
        real = os.path.realpath(directory)
        if real in seen:
            dirs[:] = []
            continue
        seen.add(real)
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            yield Path(directory) / name


class Redactor:
    def __init__(self, references, patterns):
        self.lines = set()
        self.names = set()
        self.titles = set()
        self.references = 0
        for root in references:
            paths = [root] if root.is_file() else files_under(root)
            for path in paths:
                if path.suffix.lower() != ".md":
                    continue
                text = path.read_text(errors="replace")
                self.references += 1
                for line in text.splitlines():
                    line = self.normalize(line)
                    if len(line) >= 45:
                        self.lines.add(hashlib.sha256(line.encode()).digest())
                if path.name == "SKILL.md":
                    self.names.add(path.parent.name)
                    match = re.search(r"(?m)^name:\s*[\"']?([^\n\"']+)", text)
                    if match:
                        self.names.add(match[1].strip())
                    for title in re.findall(r"(?m)^# ([^\n]+)", text):
                        if len(title) >= 8:
                            self.titles.add(title)
        # Short names are matched only in explicit skill-list/path contexts.
        self.identifiers = {n.casefold() for n in self.names if len(n) >= 8 and re.search(r"[-_]", n)}
        self.pattern = re.compile("|".join(patterns + [
            r"(?:~|/[^\s\"']*)/\.(?:codex|claude|agents)/(?:skills|rules)(?:/|\b)",
            r"\.config/opencode/(?:skills|agents|AGENTS\.md)",
            r"<(?:skills_instructions|available_skills)>",
            r"### Available skills", r"## Skills\s*\n",
        ]), re.IGNORECASE)
        self.changed_strings = 0
        self.removed_chars = 0

    @staticmethod
    def normalize(line):
        return re.sub(r"^\s*\d+\s*[|:]\s*", "", line).strip()

    @lru_cache(maxsize=1024)
    def private(self, text):
        text = MARKER.sub("", text)
        if self.pattern.search(text):
            return True
        if any(n.casefold() in self.identifiers for n in re.findall(r"\w+(?:[-_]\w+)+", text)):
            return True
        for line in text.splitlines():
            line = self.normalize(line)
            if line.removeprefix("# ") in self.titles:
                return True
            if len(line) >= 45 and hashlib.sha256(line.encode()).digest() in self.lines:
                return True
        return False

    def hide(self, text):
        if not text or MARKER.fullmatch(text):
            return text
        self.changed_strings += 1
        self.removed_chars += len(text)
        return marker(text)

    def hide_output(self, text):
        try:
            value = json.loads(text)
        except ValueError:
            return self.hide(text)
        if not isinstance(value, (list, dict)):
            return self.hide(text)

        def outputs(value):
            if isinstance(value, list):
                return [outputs(v) for v in value]
            if isinstance(value, dict):
                return {k: self.hide_output(v) if k in OUTPUT_KEYS | {"text"} and isinstance(v, str)
                        else outputs(v) for k, v in value.items()}
            return value

        cleaned = outputs(self.walk(value))
        return json.dumps(cleaned, ensure_ascii=False, separators=(",", ":"))

    def string(self, text):
        original = text
        # Serialized JSON inside event fields must remain structured when possible.
        stripped = text.strip()
        if stripped.startswith(("{", "[")):
            try:
                value = json.loads(text)
            except (ValueError, RecursionError):
                pass
            else:
                cleaned = self.walk(value)
                if cleaned != value:
                    return json.dumps(cleaned, ensure_ascii=False, separators=(",", ":"))
                return text
        # Remove bounded instruction blocks before considering the remaining field.
        text = re.sub(r"<!--\s*[\w-]+-core:start\s*-->[\s\S]*?<!--\s*[\w-]+-core:end\s*-->",
                      lambda m: self.hide(m[0]), text)
        for tag in ("skills_instructions", "available_skills"):
            text = re.sub(rf"<{tag}>[\s\S]*?</{tag}>", lambda m: self.hide(m[0]), text)
        return self.hide(original) if self.private(text) else text

    def walk(self, value, tainted_ids=frozenset()):
        if isinstance(value, str):
            return self.string(value)
        if isinstance(value, list):
            return [self.walk(v, tainted_ids) for v in value]
        if not isinstance(value, dict):
            return value
        inputs = [value[k] for k in ("cmd", "command", "input", "arguments", "action", "actions") if k in value]
        tainted = any(self.private(json.dumps(v, ensure_ascii=False)) for v in inputs)
        tainted |= any(value.get(k) in tainted_ids for k in ("id", "call_id") if isinstance(value.get(k), str))
        result = {}
        for key, item in value.items():
            if tainted and key in OUTPUT_KEYS and isinstance(item, str):
                result[key] = self.hide_output(item)
            else:
                result[key] = self.walk(item, tainted_ids)
        return result

    def ids(self, value):
        result = set()
        if isinstance(value, dict):
            inputs = [value[k] for k in ("cmd", "command", "input", "arguments") if k in value]
            if any(self.private(json.dumps(v, ensure_ascii=False)) for v in inputs):
                for key in ("id", "call_id"):
                    if isinstance(value.get(key), str):
                        result.add(value[key])
                        result.add(value[key].split(":action:")[0])
            for child in value.values():
                result.update(self.ids(child))
        if isinstance(value, list):
            for child in value:
                result.update(self.ids(child))
        return result

    def clean(self, raw, path):
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw
        # Scope instruction/name fingerprints to research artifacts and AGENTS.md.
        scoped = path.startswith(("experiments/", "articles/", "journals/")) or path.endswith("AGENTS.md")
        if not scoped:
            return raw
        if path.endswith(".jsonl"):
            records = []
            tainted = set()
            for line in text.splitlines(keepends=True):
                try:
                    value = json.loads(line)
                except ValueError:
                    value = None
                records.append((line, value))
                if value is not None:
                    tainted.update(self.ids(value))
            output = []
            for line, value in records:
                if value is None:
                    output.append(self.string(line))
                    continue
                cleaned = self.walk(value, tainted)
                output.append(line if cleaned == value else json.dumps(cleaned, ensure_ascii=False, separators=(",", ":")) + ("\n" if line.endswith("\n") else ""))
            return "".join(output).encode()
        if path.endswith(".json"):
            try:
                value = json.loads(text)
            except ValueError:
                pass
            else:
                cleaned = self.walk(value, self.ids(value))
                return raw if cleaned == value else (json.dumps(cleaned, ensure_ascii=False, indent=2) + "\n").encode()
        if path.endswith((".ts", ".py", ".js", ".sh")):
            # Do not corrupt executable code while removing historical skill names.
            # Research audit programs contain detection patterns, not private rules.
            return raw
        if path.endswith(".md"):
            text = re.sub(r"<!--\s*[\w-]+-core:start\s*-->[\s\S]*?<!--\s*[\w-]+-core:end\s*-->",
                          lambda m: self.hide(m[0]), text)
            return "\n\n".join(self.string(p) for p in text.split("\n\n")).encode()
        return self.string(text).encode()


def worktree(root, redactor, apply):
    paths = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split(b"\0")
    changed = []
    for name in sorted(set(paths)):
        if not name:
            continue
        path = os.fsdecode(name)
        file = root / path
        if not file.is_file() or file.is_symlink():
            continue
        raw = file.read_bytes()
        clean = redactor.clean(raw, path)
        if clean == raw:
            continue
        changed.append(path)
        if apply:
            file.write_bytes(clean)
    return changed


def history(root, redactor, apply):
    refs = {}
    for line in git(root, "for-each-ref", "--format=%(refname) %(objectname)").decode().splitlines():
        name, oid = line.split()
        refs[name] = oid
    if any(name.startswith(("refs/tags/", "refs/stash", "refs/replace/")) for name in refs):
        raise RuntimeError("Tags, stash or replace refs require an explicit handling policy")
    commits = git(root, "rev-list", "--reverse", "--topo-order", "--all").decode().splitlines()
    objects = git(root, "rev-list", "--objects", "--all").decode().splitlines()
    changed = {}
    types = Counter()
    batch = subprocess.Popen(["git", "-C", str(root), "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    for entry in objects:
        fields = entry.split(" ", 1)
        if len(fields) != 2:
            continue
        oid, path = fields
        if not (path.startswith(("experiments/", "journals/", "articles/")) or path.endswith("AGENTS.md")):
            continue
        batch.stdin.write((oid + "\n").encode())
        batch.stdin.flush()
        header = batch.stdout.readline().split()
        size = int(header[2])
        raw = batch.stdout.read(size)
        assert batch.stdout.read(1) == b"\n"
        if header[1] != b"blob":
            continue
        cleaned = redactor.clean(raw, path)
        if cleaned == raw:
            continue
        types[Path(path).suffix or "other"] += 1
        changed[oid] = git(root, "hash-object", *( ["-w"] if apply else []), "--stdin", data=cleaned).decode().strip()
    batch.stdin.close()
    if batch.wait() != 0:
        raise RuntimeError("Object reader failed")
    result = {"commits": len(commits), "changedBlobs": len(changed), "extensions": dict(types)}
    if not apply:
        return result
    trees = {}

    def tree(oid):
        if oid in trees:
            return trees[oid]
        entries = git(root, "ls-tree", "-z", oid).split(b"\0")
        output = []
        dirty = False
        for entry in entries:
            if not entry:
                continue
            info, name = entry.split(b"\t", 1)
            mode, kind, old = info.decode().split()
            new = tree(old) if kind == "tree" else changed.get(old, old)
            dirty |= new != old
            output.append(f"{mode} {kind} {new}\t".encode() + name + b"\0")
        trees[oid] = git(root, "mktree", "-z", data=b"".join(output)).decode().strip() if dirty else oid
        return trees[oid]

    mapping = {}
    for oid in commits:
        raw = git(root, "cat-file", "commit", oid)
        headers, message = raw.split(b"\n\n", 1)
        if b"gpgsig " in headers:
            raise RuntimeError("Signed commit requires an explicit signature-removal policy")
        output = []
        for line in headers.splitlines():
            if line.startswith(b"tree "):
                line = b"tree " + tree(line[5:].decode()).encode()
            if line.startswith(b"parent "):
                line = b"parent " + mapping[line[7:].decode()].encode()
            output.append(line)
        cleaned = b"\n".join(output) + b"\n\n" + message
        mapping[oid] = git(root, "hash-object", "-w", "-t", "commit", "--stdin", data=cleaned).decode().strip()
    transaction = "start\n" + "".join(f"update {ref} {mapping[oid]} {oid}\n" for ref, oid in refs.items()) + "prepare\ncommit\n"
    git(root, "update-ref", "--stdin", data=transaction.encode())
    # Index only: existing worktree edits/untracked research artifacts remain intact.
    git(root, "read-tree", "HEAD")
    result["refs"] = {ref: {"old": oid, "new": mapping[oid]} for ref, oid in refs.items()}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--reference", type=Path, action="append", default=[])
    parser.add_argument("--profile-pattern", action="append", default=[])
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--history", action="store_true")
    args = parser.parse_args()
    redactor = Redactor(args.reference, args.profile_pattern)
    print(json.dumps({"phase": "references-loaded", "referenceFiles": redactor.references}), flush=True)
    if args.apply and git(args.root, "diff", "--cached", "--name-only").strip():
        raise RuntimeError("Staged changes must be preserved explicitly before rewriting")
    result = {"applied": args.apply, "referenceFiles": redactor.references}
    if args.history:
        result["history"] = history(args.root, redactor, args.apply)
        print(json.dumps({"phase": "history-scanned", **result["history"]}), flush=True)
    changed = worktree(args.root, redactor, args.apply)
    result.update(changedFiles=len(changed), changedFields=redactor.changed_strings,
                  removedChars=redactor.removed_chars,
                  extensions=dict(Counter(Path(p).suffix or "other" for p in changed)))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
