require("dotenv").config({ quiet: true });
module.exports = {
  apps: [
    {
      name: "localvoice-whisper", script: "whisper_server.py", interpreter: process.env.PYTHON_PATH || "python", watch: false,
      restart_delay: 3000, max_restarts: 10, kill_timeout: 10000,
      env: { WHISPER_MODEL_SIZE: process.env.WHISPER_MODEL_SIZE || "small", WHISPER_DEVICE: process.env.WHISPER_DEVICE || "cpu", WHISPER_COMPUTE_TYPE: process.env.WHISPER_COMPUTE_TYPE || "int8", WHISPER_PORT: "8001", VOICE_SERVICE_HOST: "127.0.0.1", FFMPEG_PATH: process.env.FFMPEG_PATH || "ffmpeg" },
    },
    {
      name: "localvoice-tts", script: "tts_server.py", interpreter: process.env.PYTHON_PATH || "python", watch: false,
      restart_delay: 3000, max_restarts: 10, kill_timeout: 10000,
      env: { TTS_PORT: "8002", VOICE_SERVICE_HOST: "127.0.0.1", PIPER_VOICE: process.env.PIPER_VOICE || "./models/en_US-lessac-medium.onnx" },
    },
    {
      name: "localvoice-crm", script: "dist/index.js", interpreter: "node", watch: false,
      restart_delay: 3000, max_restarts: 10, kill_timeout: 12000, env: { NODE_ENV: "production", HOST: "127.0.0.1", PORT: "3000", TTS_MODE: "server", WHISPER_MODE: "fastapi" },
    },
  ],
};
