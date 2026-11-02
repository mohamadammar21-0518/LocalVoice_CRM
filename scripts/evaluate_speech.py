"""Compare English or Malay ASR configurations with one reproducible manifest.

Manifest JSONL fields: audio (path), text (reference), language, entities (optional list).
The target must expose the LocalVoice /transcribe multipart endpoint.
"""
import argparse
import json
import os
import pathlib
import statistics
import time
import urllib.request
import uuid


def distance(left, right):
    row = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        diagonal, row[0] = row[0], i
        for j, b in enumerate(right, 1):
            previous = row[j]
            row[j] = min(row[j] + 1, row[j - 1] + 1, diagonal + (a != b))
            diagonal = previous
    return row[-1]


def multipart(audio, filename, language):
    boundary = "----localvoice" + uuid.uuid4().hex
    body = bytearray()
    for name, value in [("language", language)]:
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: audio/wav\r\n\r\n".encode())
    body.extend(audio); body.extend(f"\r\n--{boundary}--\r\n".encode())
    return bytes(body), boundary


def percentile(values, fraction):
    if not values: return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int(len(ordered) * fraction + 0.999) - 1))]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    parser.add_argument("--url", default="http://127.0.0.1:8001/transcribe")
    parser.add_argument("--token", default=os.getenv("VOICE_SERVICE_TOKEN"), help="Prefer VOICE_SERVICE_TOKEN in the environment")
    parser.add_argument("--output", default="evaluation/speech-bakeoff.json")
    args = parser.parse_args()
    if not args.token: parser.error("Set VOICE_SERVICE_TOKEN in the environment")
    cases, latencies, errors, entity_hits, entity_total = [], [], 0, 0, 0
    for line in pathlib.Path(args.manifest).read_text(encoding="utf-8").splitlines():
        if not line.strip(): continue
        case = json.loads(line); path = pathlib.Path(case["audio"])
        if case.get("consent") is not True: parser.error("Each evaluation recording must have consent: true")
        if case.get("language") not in ("en", "ms"): parser.error("Each case needs language en or ms")
        if not path.is_absolute(): path = pathlib.Path(args.manifest).resolve().parent / path
        body, boundary = multipart(path.read_bytes(), path.name, case.get("language", "ms"))
        request = urllib.request.Request(args.url, body, {"Content-Type": f"multipart/form-data; boundary={boundary}", "X-Service-Token": args.token})
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=180) as response: result = json.load(response)
            elapsed = round((time.perf_counter() - started) * 1000); latencies.append(elapsed)
            reference_text = " ".join(case["text"].lower().split())
            hypothesis_text = " ".join(result.get("text", "").lower().split())
            reference, hypothesis = reference_text.split(), hypothesis_text.split()
            wer = distance(reference, hypothesis) / max(1, len(reference))
            character_errors = distance(reference_text, hypothesis_text)
            entities = [value.lower() for value in case.get("entities", [])]
            hits = sum(value in " ".join(hypothesis) for value in entities); entity_hits += hits; entity_total += len(entities)
            cases.append({"audio": str(path), "language": case["language"], "accent": case.get("accent", "unspecified"), "noise": case.get("noise", "unspecified"), "wordErrors": distance(reference, hypothesis), "referenceWords": len(reference), "characterErrors": character_errors, "referenceCharacters": len(reference_text), "wer": round(wer, 4), "cer": round(character_errors / max(1, len(reference_text)), 4), "entityHits": hits, "entityTotal": len(entities), "latencyMs": elapsed, "hypothesis": result.get("text", "")})
        except Exception as error:
            errors += 1; cases.append({"audio": str(path), "error": type(error).__name__})
    report = {"cases": len(cases), "errors": errors, "meanWer": round(statistics.mean([item["wer"] for item in cases if "wer" in item]), 4) if len(cases) > errors else None,
              "entityAccuracy": round(entity_hits / entity_total, 4) if entity_total else None, "p50Ms": percentile(latencies, .5), "p95Ms": percentile(latencies, .95), "results": cases}
    output = pathlib.Path(args.output); output.parent.mkdir(parents=True, exist_ok=True); output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    report["corpusWer"] = sum(c.get("wordErrors", 0) for c in cases) / max(1, sum(c.get("referenceWords", 0) for c in cases))
    report["corpusCer"] = sum(c.get("characterErrors", 0) for c in cases) / max(1, sum(c.get("referenceCharacters", 0) for c in cases))
    report["byLanguage"] = {lang: {"cases": len([c for c in cases if c.get("language") == lang]), "corpusWer": sum(c.get("wordErrors", 0) for c in cases if c.get("language") == lang) / max(1, sum(c.get("referenceWords", 0) for c in cases if c.get("language") == lang))} for lang in sorted({c["language"] for c in cases if "language" in c})}
    report["byCohort"] = {f"{lang}/{accent}/{noise}": {"cases": len(group), "wer": sum(c["wordErrors"] for c in group) / max(1, sum(c["referenceWords"] for c in group)), "cer": sum(c["characterErrors"] for c in group) / max(1, sum(c["referenceCharacters"] for c in group)), "entityAccuracy": sum(c["entityHits"] for c in group) / max(1, sum(c["entityTotal"] for c in group)), "successRate": sum(c["wer"] <= .2 and c["entityHits"] == c["entityTotal"] for c in group) / len(group)} for lang, accent, noise in sorted({(c["language"], c["accent"], c["noise"]) for c in cases if "wer" in c}) for group in [[c for c in cases if c.get("language") == lang and c.get("accent") == accent and c.get("noise") == noise and "wer" in c]]}
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "results"}))
    if errors or not cases: raise SystemExit(1)


if __name__ == "__main__": main()
