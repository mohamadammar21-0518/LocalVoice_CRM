/**
 * PM2 Ecosystem Configuration
 *
 * This file defines how to run LocalVoice CRM and its Whisper server
 * as persistent background processes with auto-restart on crash.
 *
 * Install PM2:
 *   npm install -g pm2
 *
 * Start all services:
 *   pm2 start ecosystem.config.js
 *
 * View logs:
 *   pm2 logs
 *   pm2 logs whisper-server
 *   pm2 logs localvoice-crm
 *
 * Restart all:
 *   pm2 restart all
 *
 * Stop all:
 *   pm2 stop all
 *
 * Delete all from PM2:
 *   pm2 delete all
 *
 * Auto-restart on system reboot (Windows):
 *   pm2 install pm2-windows-startup
 *   pm2 save
 */

export default {
  apps: [
    // ── Whisper STT Server (must start first) ──────────────────────────────
    {
      name: "whisper-server",
      script: "whisper_server.py",
      interpreter: "python",
      args: "",
      env: {
        WHISPER_MODEL_SIZE: "small",      // Options: base, small, medium, large-v3
        WHISPER_DEVICE: "cpu",            // Options: cpu, cuda
        WHISPER_COMPUTE_TYPE: "int8",     // Options: int8, float16, float32
        WHISPER_PORT: "8001",
        FFMPEG_PATH: process.env.FFMPEG_PATH || "ffmpeg",
      },
      watch: false,
      max_restarts: 10,
      max_memory_restart: "1G",           // Restart if memory usage exceeds 1GB
      error_file: ".pm2/whisper-server-error.log",
      out_file: ".pm2/whisper-server-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      wait_ready: true,                   // Wait for process to signal readiness
      listen_timeout: 3000,               // Grace period before marking as ready
      kill_timeout: 5000,
    },

    // ── LocalVoice CRM Node.js App ─────────────────────────────────────────
    {
      name: "localvoice-crm",
      script: "npm",
      args: "run start",
      watch: false,
      max_restarts: 5,
      max_memory_restart: "512M",
      error_file: ".pm2/app-error.log",
      out_file: ".pm2/app-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      env_production: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      // ── Dependencies: whisper-server must start first ─────────────────────
      depends_on: {
        "whisper-server": {
          "state": "started",
          "timeout": 5000,
        },
      },
    },
  ],

  // ── Deploy to production (optional) ─────────────────────────────────────
  deploy: {
    production: {
      user: "app",
      host: "your-production-server.com",
      ref: "origin/main",
      repo: "git@github.com:yourusername/localvoice-crm.git",
      path: "/opt/localvoice-crm",
      "post-deploy": "npm install && npm run build && pm2 restart ecosystem.config.js --env production",
    },
  },
};
