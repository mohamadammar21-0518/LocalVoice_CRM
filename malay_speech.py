"""Local Malay formant synthesis using the bundled eSpeak NG library.

One instance must only be called from the TTS service's single worker.
"""
import ctypes
import io
import os
import wave
from pathlib import Path
import espeakng_loader


class MalaySpeech:
    def __init__(self):
        library_path = espeakng_loader.get_library_path()
        self.dll_directory = os.add_dll_directory(str(Path(library_path).parent)) if os.name == "nt" else None
        self.library = ctypes.CDLL(library_path)
        self.library.espeak_Initialize.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
        self.library.espeak_Initialize.restype = ctypes.c_int
        self.sample_rate = self.library.espeak_Initialize(2, 0, str(Path(espeakng_loader.get_data_path()).parent).encode(), 0x8000)
        if self.sample_rate <= 0:
            raise RuntimeError("eSpeak NG initialization failed")
        self.chunks = []
        callback_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p)
        def callback(samples, count, _events):
            if samples and count:
                self.chunks.append(ctypes.string_at(samples, count * 2))
            return 0
        self.callback = callback_type(callback)
        self.library.espeak_SetSynthCallback.argtypes = [callback_type]
        self.library.espeak_SetSynthCallback(self.callback)
        self.library.espeak_SetVoiceByName.argtypes = [ctypes.c_char_p]
        self.library.espeak_Synth.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
        if self.library.espeak_SetVoiceByName(b"ms"):
            raise RuntimeError("Malay voice is unavailable")

    def synthesize(self, text):
        self.chunks = []
        # Piper shares eSpeak state for phonemization: reset the voice each time.
        if self.library.espeak_SetVoiceByName(b"ms"):
            raise RuntimeError("Malay voice is unavailable")
        encoded = text.encode("utf-8") + b"\0"
        if self.library.espeak_Synth(encoded, len(encoded), 0, 1, 0, 1, None, None):
            raise RuntimeError("Malay synthesis failed")
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(self.sample_rate)
            wav.writeframes(b"".join(self.chunks))
        return output.getvalue()
