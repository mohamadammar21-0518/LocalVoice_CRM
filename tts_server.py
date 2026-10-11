"""Persistent Piper voice service. Start with: python tts_server.py."""
import io
import os
import time
import wave
from contextlib import asynccontextmanager
import uvicorn
from fastapi import Depends, FastAPI
from fastapi.responses import Response
from pydantic import BaseModel, Field
from typing import Literal
from malay_speech import MalaySpeech
from piper import PiperVoice
from voice_runtime import ModelWorker, require_service_token

worker = ModelWorker()
voice = None
malay_voice = None


@asynccontextmanager
async def lifespan(app):
    global voice, malay_voice
    model = os.getenv("PIPER_VOICE", "./models/en_US-lessac-medium.onnx")
    voice = PiperVoice.load(model)
    malay_voice = MalaySpeech()
    yield
    worker.close()


app = FastAPI(title="LocalVoice Piper", lifespan=lifespan)


class SpeechInput(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    language: Literal["en", "ms"] = "en"


@app.get("/health", dependencies=[Depends(require_service_token)])
async def health():
    return {"ok": voice is not None, "model": os.path.basename(os.getenv("PIPER_VOICE", "")), "queued_and_active": worker.pending, "languages": ["en", "ms"], "malay_engine": "espeak-ng"}


def synthesize(queue_wait_ms, text, language):
    started = time.monotonic()
    if language == "ms":
        audio = malay_voice.synthesize(text)
        return audio, round((time.monotonic() - started) * 1000), queue_wait_ms
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        voice.synthesize_wav(text, wav)
    return output.getvalue(), round((time.monotonic() - started) * 1000), queue_wait_ms


@app.post("/synthesize", dependencies=[Depends(require_service_token)])
async def speech(data: SpeechInput):
    audio, inference_ms, queue_ms = await worker.run(synthesize, data.text, data.language)
    return Response(audio, media_type="audio/wav", headers={"X-Inference-Ms": str(inference_ms), "X-Queue-Ms": str(queue_ms)})


if __name__ == "__main__":
    uvicorn.run(app, host=os.getenv("VOICE_SERVICE_HOST", "127.0.0.1"), port=int(os.getenv("TTS_PORT", "8002")), workers=1)
