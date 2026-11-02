import json
import tempfile
import unittest
from pathlib import Path
from prepare import load_and_split


def command(group, text):
    return {"group": group, "consent": True, "reviewed": True, "messages": [{"role": "system", "content": "Schema"}, {"role": "user", "content": text}, {"role": "assistant", "content": '{"clarification":"Choose a record"}'}]}


class DatasetTests(unittest.TestCase):
    def prepare(self, rows):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        source = Path(self.directory.name) / "data.jsonl"
        source.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
        return load_and_split(source, "command")

    def test_duplicates_and_scenario_groups_never_leak(self):
        rows = [command(str(i), f"Request {i}") for i in range(20)]
        rows += [command("new-group", "Request 0"), command("0", "Different phrasing")]
        result = self.prepare(rows)
        owners = {}
        for split, records in result.items():
            for row in records:
                key = row["messages"][1]["content"]
                if key in owners:
                    self.assertEqual(owners[key], split)
                owners[key] = split
        self.assertEqual(owners["Request 0"], owners["Different phrasing"])
        self.assertEqual(sum(len(r) for r in result.values()), len(rows))

    def test_unreviewed_data_rejected(self):
        rows = [command(str(i), str(i)) for i in range(4)]
        rows[0]["reviewed"] = False
        with self.assertRaises(ValueError):
            self.prepare(rows)

    def test_too_few_independent_groups_rejected(self):
        with self.assertRaises(ValueError):
            self.prepare([command("same", str(i)) for i in range(10)])

    def test_speech_speakers_and_audio_stay_together(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = []
            for i in range(10):
                (root / f"{i}.wav").write_bytes(bytes([i]))
                rows.append({"audio": f"{i}.wav", "text": "Hello", "language": "en", "group": str(i), "speaker": str(i // 2), "consent": True, "reviewed": True})
            source = root / "speech.jsonl"
            source.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
            result = load_and_split(source, "speech")
            owners = {}
            for split, records in result.items():
                for row in records:
                    speaker = row["speaker"]
                    if speaker in owners:
                        self.assertEqual(owners[speaker], split)
                    owners[speaker] = split


if __name__ == "__main__":
    unittest.main()
