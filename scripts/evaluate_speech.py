"""Compare English or Malay ASR configurations with one reproducible manifest.

Manifest JSONL fields: audio (path), text (reference), language, entities (optional list).
The target must expose the LocalVoice /transcribe multipart endpoint.
"""
import argparse
import json
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
    parser.add_argument("--token", required=True)
    parser.add_argument("--output", default="evaluation/speech-bakeoff.json")
    args = parser.parse_args()
    cases, latencies, errors, entity_hits, entity_total = [], [], 0, 0, 0
    for line in pathlib.Path(args.manifest).read_text(encoding="utf-8").splitlines():
        case = json.loads(line); path = pathlib.Path(case["audio"])
        body, boundary = multipart(path.read_bytes(), path.name, case.get("language", "ms"))
        request = urllib.request.Request(args.url, body, {"Content-Type": f"multipart/form-data; boundary={boundary}", "X-Service-Token": args.token})
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=180) as response: result = json.load(response)
            elapsed = round((time.perf_counter() - started) * 1000); latencies.append(elapsed)
            reference, hypothesis = case["text"].lower().split(), result.get("text", "").lower().split()
            wer = distance(reference, hypothesis) / max(1, len(reference))
            entities = [value.lower() for value in case.get("entities", [])]
            hits = sum(value in " ".join(hypothesis) for value in entities); entity_hits += hits; entity_total += len(entities)
            cases.append({"audio": str(path), "wer": round(wer, 4), "entityHits": hits, "entityTotal": len(entities), "latencyMs": elapsed, "hypothesis": result.get("text", "")})
        except Exception as error:
            errors += 1; cases.append({"audio": str(path), "error": type(error).__name__})
    report = {"cases": len(cases), "errors": errors, "meanWer": round(statistics.mean([item["wer"] for item in cases if "wer" in item]), 4) if len(cases) > errors else None,
              "entityAccuracy": round(entity_hits / entity_total, 4) if entity_total else None, "p50Ms": percentile(latencies, .5), "p95Ms": percentile(latencies, .95), "results": cases}
    output = pathlib.Path(args.output); output.parent.mkdir(parents=True, exist_ok=True); output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "results"}))


if __name__ == "__main__": main()
