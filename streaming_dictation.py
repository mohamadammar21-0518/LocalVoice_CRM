"""Local English streaming ASR. Each frame is decoded once; no Whisper re-decoding."""
import io
import json
import os
import time
import wave
from fastapi import Depends, HTTPException, Request
from voice_runtime import ModelWorker, require_service_token


class EnglishDictation:
    def __init__(self):
        self.model = None
        self.sessions = {}
        self.worker = ModelWorker()

    def load(self):
        from vosk import Model, SetLogLevel
        SetLogLevel(-1)
        location = os.getenv("VOSK_MODEL_PATH", "models/vosk-model-small-en-us-0.15")
        if os.path.isdir(location):
            self.model = Model(location)

    def decode(self, queue_ms, identifier, sequence, final, audio):
        from vosk import KaldiRecognizer
        inference_started = time.perf_counter()
        if self.model is None:
            raise HTTPException(503, "English dictation model is unavailable")
        now = time.monotonic()
        self.sessions = {key: value for key, value in self.sessions.items() if value["expires"] > now}
        state = self.sessions.get(identifier)
        if state is None:
            if sequence != 0:
                raise HTTPException(409, "Dictation expired")
            if len(self.sessions) >= 16:
                raise HTTPException(503, "Dictation capacity reached")
            decoder = KaldiRecognizer(self.model, 16000)
            decoder.SetWords(True)
            state = {"decoder": decoder, "sequence": 0, "text": [], "confidence": [], "expires": now + 180, "samples": 0}
            self.sessions[identifier] = state
        if sequence != state["sequence"]:
            raise HTTPException(409, "Unexpected audio frame")
        try:
            with wave.open(io.BytesIO(audio), "rb") as wav:
                if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth(), wav.getcomptype()) != (16000, 1, 2, "NONE"):
                    raise ValueError("Unsupported PCM format")
                pcm = wav.readframes(wav.getnframes())
        except (wave.Error, EOFError, ValueError):
            raise HTTPException(400, "Expected mono 16 kHz PCM WAV")
        if len(pcm) > 64000 or state["samples"] + len(pcm) // 2 > 1920000:
            raise HTTPException(400, "Dictation duration limit exceeded")
        state["samples"] += len(pcm) // 2
        decoder = state["decoder"]
        if pcm and decoder.AcceptWaveform(pcm):
            completed = json.loads(decoder.Result())
            state["text"].append(completed.get("text", ""))
            state["confidence"].extend(word.get("conf", 0) for word in completed.get("result", []))
        if final:
            completed = json.loads(decoder.FinalResult())
            state["text"].append(completed.get("text", ""))
            state["confidence"].extend(word.get("conf", 0) for word in completed.get("result", []))
            partial = ""
            del self.sessions[identifier]
        else:
            partial = json.loads(decoder.PartialResult()).get("partial", "")
        state["sequence"] += 1
        return {"text": " ".join(item for item in [*state["text"], partial] if item), "language": "en", "final": final,
                "duration": state["samples"] / 16000, "confidence": round(sum(state["confidence"]) / len(state["confidence"]), 3) if state["confidence"] else None, "queue_ms": queue_ms,
                "inference_ms": round((time.perf_counter() - inference_started) * 1000, 2)}

    def register(self, app):
        @app.delete("/dictate/{identifier}", dependencies=[Depends(require_service_token)])
        async def cancel(identifier: str):
            await self.worker.run(lambda _queue_ms: self.sessions.pop(identifier, None) is not None)
            return {"ok": True}

        @app.post("/dictate/{identifier}", dependencies=[Depends(require_service_token)])
        async def dictate(identifier: str, request: Request, sequence: int = 0, final: bool = False):
            if len(identifier) != 36 or not all(c in "0123456789abcdef-" for c in identifier) or sequence < 0 or sequence > 520:
                raise HTTPException(400, "Invalid dictation session")
            audio = bytearray()
            async for chunk in request.stream():
                audio.extend(chunk)
                if len(audio) > 65000:
                    raise HTTPException(413, "Audio frame too large")
            return await self.worker.run(self.decode, identifier, sequence, final, bytes(audio))
