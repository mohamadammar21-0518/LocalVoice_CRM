"""Benchmark local faster-whisper models on the same labelled speech corpus.

This runs separately from whisper_server.py and never changes its active model.
Manifest rows: {"audio": "audio/example.wav", "text": "spoken words", "language": "en", "entities": ["Acme"]}.
Audio paths are relative to the manifest. Keep real recordings and reports private.
"""

import argparse
import gc
import json
import pathlib
import time
import unicodedata

from faster_whisper import WhisperModel


PROMPT = "Customer relationship management. Transcribe names and dates accurately. Do not add words that were not spoken."


def words(value):
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in normalized).split()


def distance(left, right):
    row = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        diagonal, row[0] = row[0], i
        for j, b in enumerate(right, 1):
            previous = row[j]
            row[j] = min(row[j] + 1, row[j - 1] + 1, diagonal + (a != b))
            diagonal = previous
    return row[-1]


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int(len(ordered) * fraction + 0.999) - 1))]


def contains_entity(transcript_words, entity):
    needle = words(entity)
    return bool(needle) and any(transcript_words[index:index + len(needle)] == needle
                                for index in range(len(transcript_words) - len(needle) + 1))


def load_cases(manifest):
    cases = []
    for number, line in enumerate(manifest.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        case = json.loads(line)
        audio = pathlib.Path(case["audio"])
        if not audio.is_absolute():
            audio = manifest.resolve().parent / audio
        if not audio.is_file() or not isinstance(case["text"], str) or not case["text"].strip():
            raise ValueError(f"Manifest line {number}: audio and reference text are required")
        language = case.get("language", "en")
        if language not in ("en", "ms"):
            raise ValueError(f"Manifest line {number}: language must be en or ms")
        entities = case.get("entities", [])
        if not isinstance(entities, list) or any(not isinstance(entity, str) for entity in entities):
            raise ValueError(f"Manifest line {number}: entities must be a list of strings")
        cases.append({"audio": audio, "text": case["text"], "language": language, "entities": entities})
    if not cases:
        raise ValueError("Manifest is empty; provide labelled recordings before benchmarking")
    return cases


def benchmark(model_name, cases, device, compute_type, beam_size):
    started = time.perf_counter()
    model = WhisperModel(model_name, device=device, compute_type=compute_type, num_workers=1)
    load_ms = round((time.perf_counter() - started) * 1000)
    results = []
    for case in cases:
        started = time.perf_counter()
        segments, _ = model.transcribe(str(case["audio"]), language=case["language"],
                                       initial_prompt=PROMPT, beam_size=beam_size,
                                       word_timestamps=False, vad_filter=True,
                                       vad_parameters={"min_silence_duration_ms": 500})
        transcript = " ".join(segment.text.strip() for segment in segments)
        elapsed = round((time.perf_counter() - started) * 1000)
        reference, hypothesis = words(case["text"]), words(transcript)
        entity_hits = sum(contains_entity(hypothesis, entity) for entity in case["entities"])
        results.append({"audio": str(case["audio"]), "language": case["language"],
                        "referenceWords": len(reference), "wordErrors": distance(reference, hypothesis),
                        "entityHits": entity_hits, "entityTotal": len(case["entities"]),
                        "latencyMs": elapsed, "hypothesis": transcript})
    del model
    gc.collect()
    latencies = [result["latencyMs"] for result in results]
    reference_words = sum(result["referenceWords"] for result in results)
    entities = sum(result["entityTotal"] for result in results)
    return {"model": model_name, "loadMs": load_ms, "cases": len(results),
            "corpusWer": round(sum(result["wordErrors"] for result in results) / max(1, reference_words), 4),
            "entityAccuracy": round(sum(result["entityHits"] for result in results) / entities, 4) if entities else None,
            "p50Ms": percentile(latencies, .5), "p95Ms": percentile(latencies, .95),
            "byLanguage": {language: {"cases": len(items), "corpusWer": round(sum(item["wordErrors"] for item in items) / max(1, sum(item["referenceWords"] for item in items)), 4)}
                           for language in sorted({item["language"] for item in results})
                           for items in [[item for item in results if item["language"] == language]]},
            "results": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=pathlib.Path)
    parser.add_argument("--models", nargs="+", default=["tiny", "small", "large-v3-turbo", "large-v3"])
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--beam-size", type=int, default=1)
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("evaluation/speech-model-bakeoff.json"))
    args = parser.parse_args()
    if args.beam_size < 1:
        parser.error("--beam-size must be positive")
    try:
        cases = load_cases(args.manifest)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        parser.error(str(error))
    report = {"device": args.device, "computeType": args.compute_type, "beamSize": args.beam_size,
              "manifest": str(args.manifest), "models": [], "errors": []}
    for model_name in args.models:
        try:
            result = benchmark(model_name, cases, args.device, args.compute_type, args.beam_size)
            report["models"].append(result)
            print(json.dumps({key: value for key, value in result.items() if key != "results"}), flush=True)
        except Exception as error:
            report["errors"].append({"model": model_name, "error": type(error).__name__, "message": str(error)})
            print(f"{model_name}: {type(error).__name__}: {error}", flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Private report: {args.output}")
    if report["errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
