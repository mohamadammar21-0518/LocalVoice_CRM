"""Bounded worker admission keeps the ASGI event loop responsive during inference."""
import asyncio
import hmac
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from fastapi import Header, HTTPException
from dotenv import load_dotenv

load_dotenv()


def require_service_token(x_service_token: str = Header(default="")):
    expected = os.getenv("VOICE_SERVICE_TOKEN", "")
    if expected and not hmac.compare_digest(expected, x_service_token):
        raise HTTPException(401, "Unauthorized")


class ModelWorker:
    def __init__(self):
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voice-model")
        self.capacity = int(os.getenv("VOICE_QUEUE_LIMIT", "8")) + 1
        self.slots = threading.BoundedSemaphore(self.capacity)
        self.lock = threading.Lock()
        self.pending = 0

    async def run(self, function, *args):
        if not self.slots.acquire(blocking=False):
            raise HTTPException(503, "Voice service queue is full")
        queued = time.monotonic()
        with self.lock:
            self.pending += 1

        def work():
            wait_ms = round((time.monotonic() - queued) * 1000)
            if wait_ms > int(os.getenv("VOICE_QUEUE_TIMEOUT_MS", "15000")):
                raise HTTPException(503, "Voice service queue timed out")
            return function(wait_ms, *args)

        def release(_):
            with self.lock:
                self.pending -= 1
            self.slots.release()

        future = asyncio.get_running_loop().run_in_executor(self.executor, work)
        # Do not free capacity while a cancelled HTTP request is still computing.
        future.add_done_callback(release)
        return await asyncio.shield(future)

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=True)
