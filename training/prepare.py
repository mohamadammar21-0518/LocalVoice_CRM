"""Validate reviewed data and split by connected groups without train/test leakage.

No models or network dependencies. A speaker, duplicate audio, or scenario group
never appears in more than one split. Actual training requires explicit invocation.
"""
import argparse
import hashlib
import json
from pathlib import Path


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def load_and_split(source, task, personal_voice=False):
    source = Path(source).resolve()
    rows = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows:
        raise ValueError("Dataset is empty")
    parent = list(range(len(rows)))
    seen = {}
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i, row in enumerate(rows):
        if row.get("consent") is not True or row.get("reviewed") is not True:
            raise ValueError(f"Row {i + 1} needs explicit consent and review")
        if not isinstance(row.get("group"), str) or not row["group"].strip():
            raise ValueError(f"Row {i + 1} needs a scenario group")
        keys = ["group:" + row["group"]]
        if task == "command":
            messages = row.get("messages", [])
            if [m.get("role") for m in messages] != ["system", "user", "assistant"] or any(not isinstance(m.get("content"), str) or not m["content"].strip() for m in messages):
                raise ValueError(f"Row {i + 1} must contain system, user and assistant messages")
            expected = json.loads(messages[-1]["content"])
            if not isinstance(expected, dict) or not (expected.get("clarification") or expected.get("operation") in ["create", "update", "delete"]):
                raise ValueError(f"Row {i + 1} needs action JSON or clarification")
            keys.append("prompt:" + digest(messages[1]["content"].strip().casefold()))
            row["prompt"] = messages[:-1]
            row["completion"] = messages[-1:]
        else:
            if row.get("language") not in ["en", "ms"] or not row.get("speaker") or not str(row.get("text", "")).strip():
                raise ValueError(f"Row {i + 1} needs English/Malay, corrected text, and a speaker group")
            audio = (source.parent / row["audio"]).resolve()
            if not audio.is_relative_to(source.parent) or not audio.is_file():
                raise ValueError("Audio must exist inside the exported dataset directory")
            actual = hashlib.sha256(audio.read_bytes()).hexdigest()
            if row.get("sha256") and row["sha256"] != actual:
                raise ValueError("Audio checksum mismatch")
            row["audio"] = str(audio)
            # A normal evaluation must prove that a model works for speakers it
            # never saw in training. A personal-dictation adapter has a different
            # goal: it is intentionally evaluated on held-out utterances from its
            # one consented speaker. Scenario groups and duplicate-audio guards
            # still prevent prompt/audio leakage in both modes.
            if not personal_voice:
                keys.append("speaker:" + row["speaker"])
            keys.append("audio:" + actual)
        for key in keys:
            if key in seen:
                parent[find(i)] = find(seen[key])
            else:
                seen[key] = i
    components = {}
    for i, row in enumerate(rows):
        components.setdefault(find(i), []).append(row)
    ordered = sorted(components.values(), key=lambda group: digest("|".join(sorted(r["group"] for r in group))))
    if len(ordered) < 3:
        raise ValueError("Need at least three independent groups (and three speakers for speech) for train/validation/test separation")
    n_test = max(1, round(len(ordered) * .1))
    n_val = max(1, round(len(ordered) * .1))
    split = {"test": ordered[:n_test], "validation": ordered[n_test:n_test + n_val], "train": ordered[n_test + n_val:]}
    return {name: [row for group in groups for row in group] for name, groups in split.items()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("task", choices=["command", "speech"])
    parser.add_argument("source")
    parser.add_argument("output")
    parser.add_argument("--personal-voice", action="store_true", help="Allow one consented speaker across splits; evaluation then measures only that speaker.")
    args = parser.parse_args()
    if args.personal_voice and args.task != "speech":
        raise ValueError("--personal-voice is only valid for speech datasets")
    splits = load_and_split(args.source, args.task, args.personal_voice)
    output = Path(args.output)
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output directory must be empty")
    output.mkdir(parents=True, exist_ok=True)
    for name, rows in splits.items():
        (output / f"{name}.jsonl").write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n", encoding="utf-8")
    policy = "connected scenario groups, speakers and duplicate inputs stay together"
    if args.personal_voice:
        policy = "personal-voice: scenario groups and duplicate inputs stay together; the consented speaker may appear across splits"
    manifest = {"task": args.task, "sourceSha256": hashlib.sha256(Path(args.source).read_bytes()).hexdigest(), "counts": {k: len(v) for k, v in splits.items()}, "groupPolicy": policy, "personalVoice": args.personal_voice}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
