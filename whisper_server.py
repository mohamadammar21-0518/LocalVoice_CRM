"""Persistent faster-whisper service with bounded, off-event-loop inference."""
import os
import io
import subprocess
import tempfile
import time
import wave
import numpy as np
from contextlib import asynccontextmanager
from typing import Optional
import uvicorn
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel
from voice_runtime import ModelWorker, require_service_token
from streaming_dictation import EnglishDictation

MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "small")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8" if DEVICE == "cpu" else "float16")
FFMPEG = os.getenv("FFMPEG_PATH", "ffmpeg")
worker = ModelWorker()
model = None
dictation = EnglishDictation()


@asynccontextmanager
async def lifespan(app):
    global model
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE,
                         cpu_threads=int(os.getenv("WHISPER_CPU_THREADS", str(max(1, (os.cpu_count() or 4) // 2)))), num_workers=1)
    try:
        dictation.load()
    except ImportError:
        print("English dictation unavailable: install vosk and its English model", flush=True)
    yield
    worker.close()
    dictation.worker.close()


app = FastAPI(title="LocalVoice Whisper", lifespan=lifespan)
dictation.register(app)


@app.get("/health", dependencies=[Depends(require_service_token)])
async def health():
    return {"ok": model is not None, "model": MODEL_SIZE, "device": DEVICE, "compute_type": COMPUTE_TYPE, "queued_and_active": worker.pending, "english_dictation": dictation.model is not None}


def transcribe_audio(queue_wait_ms, audio_bytes, suffix, language, prompt):
    request_start = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="localvoice-whisper-") as directory:
        input_path = os.path.join(directory, "input" + suffix)
        wav_path = os.path.join(directory, "converted.wav")
        with open(input_path, "wb") as output:
            output.write(audio_bytes)
        conversion_start = time.monotonic()
        audio = None
        # Browser previews already contain mono 16 kHz PCM. Avoid spawning ffmpeg.
        if suffix == ".wav":
            try:
                with wave.open(io.BytesIO(audio_bytes), "rb") as wav:
                    if wav.getnchannels() == 1 and wav.getframerate() == 16000 and wav.getsampwidth() == 2 and wav.getcomptype() == "NONE":
                        raw = wav.readframes(wav.getnframes())
                        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                        duration_ms = round(len(audio) / 16)
            except (wave.Error, EOFError, ValueError):
                pass
        if audio is None:
            try:
                conversion = subprocess.run([FFMPEG, "-nostdin", "-y", "-i", input_path, "-t", "121", "-ar", "16000", "-ac", "1", "-f", "wav", wav_path], capture_output=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            except (OSError, subprocess.TimeoutExpired):
                raise HTTPException(503, "Audio conversion is unavailable or timed out")
            if conversion.returncode:
                raise HTTPException(400, "Audio format could not be decoded")
            with wave.open(wav_path, "rb") as wav:
                duration_ms = round(wav.getnframes() / wav.getframerate() * 1000)
                audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        conversion_ms = round((time.monotonic() - conversion_start) * 1000)
        if duration_ms > 120000:
            raise HTTPException(400, "Keep voice commands under two minutes")
        inference_start = time.monotonic()
        segments, info = model.transcribe(audio, language=language or None, initial_prompt=prompt or None,
                                         beam_size=int(os.getenv("WHISPER_BEAM_SIZE", "1")), word_timestamps=False,
                                         vad_filter=True, vad_parameters={"min_silence_duration_ms": 500})
        result = list(segments)
        inference_ms = round((time.monotonic() - inference_start) * 1000)
        return {"text": " ".join(item.text.strip() for item in result), "language": info.language,
                "language_probability": info.language_probability, "audio_duration_ms": duration_ms,
                "segments": [{"start": item.start, "end": item.end, "text": item.text.strip()} for item in result],
                "timing_ms": {"convert": conversion_ms, "queue_wait": queue_wait_ms, "inference": inference_ms,
                              "total": round((time.monotonic() - request_start) * 1000) + queue_wait_ms}}


@app.post("/transcribe", dependencies=[Depends(require_service_token)])
async def transcribe(file: UploadFile = File(...), language: Optional[str] = Form(default=None), prompt: Optional[str] = Form(default=None)):
    audio = await file.read(16 * 1024 * 1024 + 1)
    await file.close()
    if not audio or len(audio) > 16 * 1024 * 1024:
        raise HTTPException(400, "Audio must contain 1 byte to 16 MB")
    if language and (len(language) > 8 or not language.replace("-", "").isalpha()):
        raise HTTPException(400, "Invalid language")
    suffix = os.path.splitext(file.filename or "voice.webm")[1].lower()
    if suffix not in [".webm", ".ogg", ".mp3", ".wav", ".m4a", ".mp4"]:
        suffix = ".webm"
    return await worker.run(transcribe_audio, audio, suffix, language, (prompt or "")[:500])


if __name__ == "__main__":
    # Pass the loaded app itself to avoid importing this module and loading models twice.
    uvicorn.run(app, host=os.getenv("VOICE_SERVICE_HOST", "127.0.0.1"), port=int(os.getenv("WHISPER_PORT", "8001")), workers=1)
