# LocalVoice CRM

**A local-first voice CRM copilot for English and Malay workflows.**

LocalVoice turns spoken CRM requests into live transcripts, grounded answers, and reviewable actions. It can find contacts, read open tasks, summarize interaction history, prepare notes and follow-ups, and connect to Salesforce or HubSpot. The speech and language stack runs locally with open-source models, so the system is designed around privacy, predictable cost, and measurable latency.

> **Portfolio project:** this repository demonstrates applied AI engineering, voice UX, full-stack development, CRM integrations, and production safeguards. It is ready for local demos and continued hardening; complete the deployment checklist and an organization-specific security review before using real customer data in production.

## Why this project matters

Most voice demos stop after converting audio into text. LocalVoice follows the complete business workflow: capture speech, understand the request, retrieve CRM records, propose a safe action, ask for confirmation, save the result transactionally, and speak the response back.

The project is built to answer a practical engineering question: how can a voice CRM feel responsive without sending every audio frame and model request to a metered cloud API? The answer is measured locally rather than assumed. English uses persistent Vosk dictation, Malay and fallback transcription use faster-whisper, common CRM requests bypass the language model through deterministic routing, and every major stage records p50, p95, and p99 latency.

### Skills demonstrated

- Real-time audio capture, 16 kHz resampling, adaptive voice activity detection, endpointing, and barge-in.
- Open-source speech recognition and synthesis with Vosk, faster-whisper, Piper, and eSpeak NG.
- Latency instrumentation from microphone capture through first playback.
- Constrained intent parsing with deterministic shortcuts and local Ollama inference.
- React, TypeScript, Node.js, Express, tRPC, Zod, MySQL, and Drizzle ORM.
- Salesforce OAuth and CRM retrieval, HubSpot synchronization, owner-scoped authorization, and transactional writes.
- Evaluation methodology using transcription latency, word error rate, entity accuracy, and model bake-offs.

### Product flow

```text
Speak or type
    ↓
Live transcription and confidence check
    ↓
Deterministic CRM route or constrained local intent model
    ↓
Owner-scoped CRM retrieval
    ↓
Grounded answer or editable action proposal
    ↓
Human confirmation for writes
    ↓
Transactional CRM update and spoken receipt
```

### Current status

The local single-instance workflow is implemented and measured. The remaining enterprise steps are infrastructure choices rather than hidden features: shared live state for multiple replicas, SIP/WebRTC telephony, speaker diarization, and a validated Malay model comparison using consented recordings.

## Table of contents

- [Why this project matters](#why-this-project-matters)
- [What it does](#what-it-does)
- [Technology stack](#technology-stack)
- [System architecture](#system-architecture)
- [Voice architecture](#voice-architecture)
- [CRM write safety](#crm-write-safety)
- [Data model](#data-model)
- [Requirements](#requirements)
- [Quick start on Windows](#quick-start-on-windows)
- [Configuration](#configuration)
- [Running the application](#running-the-application)
- [Salesforce and HubSpot](#salesforce-and-hubspot)
- [Security and privacy](#security-and-privacy)
- [Performance and cost](#performance-and-cost)
- [Testing and quality checks](#testing-and-quality-checks)
- [Operations and deployment](#operations-and-deployment)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [Limitations and roadmap](#limitations-and-roadmap)
- [Competitive research](#competitive-research)
- [License](#license)

## What it does

### CRM workspace

- Manage owner-scoped contacts, interaction notes, and follow-up tasks.
- Search contacts by name, company, role, email, or semantic similarity when embeddings are available.
- View dashboard counts for contacts, open follow-ups, and overdue work.
- Manage local users and roles through the administrator workspace.
- Record audit events, voice sessions, model timing, and playback timing.

### Voice assistant

- Dictate English text while speaking with a persistent local Vosk streaming recognizer.
- Transcribe Malay and uploaded recordings with multilingual faster-whisper.
- Read CRM data and prepare supported actions from English or Malay requests.
- Use deterministic rules for common commands and a local Ollama model for complex intent parsing.
- Speak English replies with Piper and Malay replies with eSpeak NG.
- Begin playback in short chunks while later chunks are synthesized.
- Show latency for transcription, intent parsing, CRM retrieval, and first audio playback.

### Safe automation

- Read contacts, interaction history, follow-ups, and dashboard totals.
- Prepare notes and follow-ups as editable proposals.
- Require the user to select the correct contact and confirm changes before saving.
- Commit confirmed action batches transactionally and make identical retries safe.
- Reject unsupported voice actions such as deleting records or sending email.

### Integrations

- **Salesforce Developer Edition:** per-user OAuth connection, contact search, and directly linked open-task lookup. This integration is read-only.
- **HubSpot:** administrator-controlled import, live reads, explicit sync, job history, and uncertain-result reconciliation.
- **MySQL:** primary local CRM data store with owner boundaries and foreign-key protection.

## Technology stack

| Layer            | Technology                                       | Purpose                                                     |
| ---------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| Web client       | React 19, TypeScript, Vite, TanStack Query, tRPC | CRM interface, microphone capture, streaming playback       |
| API server       | Node.js 22, Express, tRPC, Zod                   | Authentication, validation, CRM workflows, integrations     |
| Database         | MySQL 8, Drizzle ORM                             | Contacts, notes, tasks, users, audit records, metrics       |
| Intent engine    | Deterministic parser + Ollama                    | Fast common commands and constrained complex intent parsing |
| English STT      | Vosk small English model                         | Low-latency partial dictation while speaking                |
| Multilingual STT | faster-whisper / CTranslate2                     | Malay, uploaded files, and fallback transcription           |
| English TTS      | Piper                                            | Local neural speech synthesis                               |
| Malay TTS        | eSpeak NG                                        | Lightweight local Malay speech synthesis                    |
| External CRM     | Salesforce REST/OAuth, HubSpot API               | Optional enterprise CRM connectivity                        |
| Testing          | Vitest, Testing Library, Happy DOM               | Server, contract, reliability, and interface tests          |

## System architecture

```mermaid
flowchart LR
    User[User] -->|HTTPS or localhost| Browser[React web client]

    subgraph Application[LocalVoice CRM application]
        Browser -->|tRPC and authenticated HTTP| API[Express and tRPC server]
        API --> Auth[Local session and role checks]
        API --> Voice[Voice orchestration]
        API --> Integrations[Integration adapters]
        API --> Storage[Recording storage]
        API --> Metrics[Metrics and audit service]
    end

    API --> MySQL[(MySQL)]
    Voice --> Ollama[Ollama local LLM]
    Voice --> Speech[Python speech service]
    Voice --> TTS[Python TTS service]
    Speech --> Vosk[Vosk English streaming model]
    Speech --> Whisper[faster-whisper multilingual model]
    TTS --> Piper[Piper English voice]
    TTS --> ESpeak[eSpeak NG Malay voice]
    Integrations -->|Optional OAuth/API| Salesforce[Salesforce]
    Integrations -->|Optional private token/API| HubSpot[HubSpot]
```

The Node server is the only service exposed to the browser. MySQL, Ollama, Whisper/Vosk, and TTS should remain private and bind to loopback or an internal network.

## Voice architecture

### Real-time English dictation

The browser captures mono PCM audio and sends a frame roughly every 250 ms. A persistent Vosk decoder processes each frame once and returns partial text. On Stop, the browser flushes the final samples, waits for queued frames, requests the final result, and reuses that transcript when saving the recording.

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant API as Node API
    participant Vosk as Vosk service
    participant DB as MySQL and storage

    User->>Browser: Start recording
    Browser->>API: Create owner-bound live session
    loop About every 250 ms
        Browser->>API: PCM frame and sequence number
        API->>Vosk: Forward authenticated frame
        Vosk-->>API: Partial English transcript
        API-->>Browser: Updated words
        Browser-->>User: Render text while speaking
    end
    User->>Browser: Stop
    Browser->>API: Flush final frame
    API->>Vosk: Finalize decoder
    Vosk-->>API: Final transcript
    Browser->>API: Save recording with live-session reference
    API->>DB: Save recording and voice session
    API-->>Browser: Completed transcript
```

Live sessions are authenticated, owner-bound, sequential, rate-limited, short-lived, and memory-bounded. If streaming fails or falls behind, the application retains the MediaRecorder audio and runs full faster-whisper transcription after Stop.

### Malay and fallback transcription

Malay currently uses short phrase updates through multilingual faster-whisper. A completed audio file is also sent through faster-whisper when live capture is unavailable, the browser lacks AudioWorklet support, or an uploaded file is used.

For CPU deployments, the recommended starting point is:

```env
WHISPER_MODEL_SIZE=small
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
WHISPER_BEAM_SIZE=1
```

### Voice CRM request lifecycle

```mermaid
flowchart TD
    A[Typed or transcribed request] --> B{Common supported command?}
    B -->|Yes| C[Deterministic intent parser]
    B -->|No| D[Ollama constrained JSON intent]
    C --> E[Validated intent]
    D --> E
    E --> F{Read or write?}
    F -->|Read| G[Owner-scoped CRM retrieval]
    G --> H[Grounded response with sources]
    F -->|Write| I[Create editable proposal]
    I --> J[User reviews contact, text, and date]
    J --> K{Confirmed?}
    K -->|Yes| L[Transactional save and audit event]
    K -->|No| M[Discard proposal]
    H --> N[Chunked local speech synthesis]
    L --> N
    N --> O[Browser plays first chunk immediately]
```

The language model converts a request into a validated intent. CRM answers are rendered from retrieved records; the model is not trusted to invent customer facts or claim that an action was saved.

## CRM write safety

Voice writes follow a prepare-review-confirm workflow:

1. The request becomes a constrained proposal containing at most five supported actions.
2. Contact references are resolved against records owned by the signed-in user.
3. Ambiguous or missing contacts require an explicit selection.
4. Notes, task titles, timezone, and due dates remain editable.
5. Confirmation locks the relevant records and checks the stored proposal revision.
6. The complete batch commits in one database transaction with an audit record.
7. Repeating the same confirmation returns the existing receipt; a changed retry conflicts.

Supported voice operations are contact lookup, interaction-history reads, follow-up reads, dashboard counts, note proposals, and follow-up proposals.

## Data model

```mermaid
erDiagram
    USERS ||--o{ CONTACTS : owns
    USERS ||--o{ VOICE_SESSIONS : creates
    USERS ||--o{ AUDIT_EVENTS : generates
    USERS ||--o{ VOICE_METRICS : records
    USERS ||--o{ HUBSPOT_SYNC_JOBS : runs
    CONTACTS ||--o{ INTERACTIONS : has
    CONTACTS ||--o{ FOLLOW_UP_TASKS : has
    VOICE_SESSIONS ||--o{ RECORDINGS : contains
    VOICE_SESSIONS ||--o{ AUDIT_EVENTS : traces

    USERS {
        int id PK
        string openId UK
        string role
        int sessionVersion
    }
    CONTACTS {
        int id PK
        int userId FK
        string firstName
        string lastName
        string email
        string hubspotId
    }
    INTERACTIONS {
        int id PK
        int userId FK
        int contactId FK
        string kind
        text body
    }
    FOLLOW_UP_TASKS {
        int id PK
        int userId FK
        int contactId FK
        string title
        datetime dueAt
        string status
    }
    VOICE_SESSIONS {
        int id PK
        int userId FK
        text transcript
        string status
        int sttLatencyMs
    }
    RECORDINGS {
        int id PK
        int userId FK
        int voiceSessionId FK
        string storageKey
    }
```

The full schema is defined in [`drizzle/schema.ts`](drizzle/schema.ts). Composite ownership constraints prevent records from being attached to another user's contact or voice session.

## Requirements

- Windows 10/11, Linux, or macOS. The documented local workflow uses Windows PowerShell.
- Node.js 22.12 or newer.
- pnpm 10.
- Python 3.12.
- MySQL 8.
- FFmpeg available on `PATH` or configured with `FFMPEG_PATH`.
- Ollama with the configured model installed.
- Approximately 2–4 GB of free storage for dependencies and local models, depending on the selected Whisper and Ollama models.
- A modern browser with microphone and AudioWorklet support. Microphone capture requires `localhost` or HTTPS.

Salesforce and HubSpot accounts are optional.

## Quick start on Windows

### 1. Install application dependencies

```powershell
pnpm install --frozen-lockfile
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock.txt
```

If pnpm warns that the `pnpm` field is ignored, the application can still run, but move `patchedDependencies` and `overrides` to `pnpm-workspace.yaml` before relying on them during a clean deployment.

### 2. Create local configuration

Copy the example only for a new installation. Preserve an existing `.env` because it may contain database, encryption, and integration credentials.

```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Put the generated value in `JWT_SECRET`. Set `DATABASE_URL`, a bootstrap `LOCAL_ADMIN_PASSWORD` of at least 12 characters, and a random internal `VOICE_SERVICE_TOKEN`.

### 3. Install local models

Install the Ollama model configured by `OLLAMA_MODEL`:

```powershell
ollama pull llama3.1
```

Download and extract the official Vosk small English model into:

```text
models/vosk-model-small-en-us-0.15
```

Model download: [Vosk model list](https://alphacephei.com/vosk/models)

Download the Piper English voice:

```powershell
.\.venv\Scripts\python.exe -m piper.download_voices --data-dir models en_US-lessac-medium
```

Set `PIPER_VOICE=./models/en_US-lessac-medium.onnx`. faster-whisper downloads the configured multilingual model on its first start.

### 4. Prepare the database

Preview migration changes first:

```powershell
pnpm db:migrate
```

After reviewing the plan and taking a backup for an existing database:

```powershell
pnpm db:migrate --apply
```

### 5. Start the services

Use separate terminals:

```powershell
# Terminal 1: Ollama
ollama serve

# Terminal 2: English/Malay speech recognition
.\.venv\Scripts\python.exe whisper_server.py

# Terminal 3: text-to-speech
.\.venv\Scripts\python.exe tts_server.py

# Terminal 4: application
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

Do not run `pnpm dev` and `pnpm start` together on port 3000. If startup reports that port 3000 is already in use, stop the existing CRM process or choose another `PORT` and update `APP_ORIGIN` to match.

## Configuration

### Core application

| Variable               | Required | Example                                           | Description                                    |
| ---------------------- | -------: | ------------------------------------------------- | ---------------------------------------------- |
| `DATABASE_URL`         |      Yes | `mysql://user:password@127.0.0.1:3306/localvoice` | MySQL connection string                        |
| `JWT_SECRET`           |      Yes | generated value                                   | Session signing secret, at least 32 characters |
| `LOCAL_ADMIN_USERNAME` |      Yes | `admin`                                           | Initial local login name                       |
| `LOCAL_ADMIN_PASSWORD` |      Yes | private value                                     | Initial password, at least 12 characters       |
| `APP_ORIGIN`           |      Yes | `http://localhost:3000`                           | Exact browser origin, without a path           |
| `HOST` / `PORT`        |       No | `127.0.0.1` / `3000`                              | Application listener                           |
| `APP_TIMEZONE`         |       No | `Asia/Kuala_Lumpur`                               | Default IANA timezone                          |
| `LOCAL_STORAGE_PATH`   |       No | `./uploads`                                       | Recording storage directory                    |

### Local AI and speech

| Variable               | Default                              | Description                                                                  |
| ---------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| `OLLAMA_BASE_URL`      | `http://127.0.0.1:11434`             | Ollama service URL                                                           |
| `OLLAMA_MODEL`         | `llama3.1`                           | Installed model used for complex CRM intents                                 |
| `WHISPER_SERVER_URL`   | `http://127.0.0.1:8001`              | faster-whisper and Vosk service                                              |
| `WHISPER_MODEL_SIZE`   | `small`                              | Multilingual Whisper model size                                              |
| `WHISPER_COMPUTE_TYPE` | `int8` on CPU                        | CTranslate2 precision                                                        |
| `VOSK_MODEL_PATH`      | `models/vosk-model-small-en-us-0.15` | English streaming model directory                                            |
| `TTS_SERVER_URL`       | `http://127.0.0.1:8002`              | Piper/eSpeak service                                                         |
| `PIPER_VOICE`          | platform dependent                   | Piper `.onnx` voice path                                                     |
| `VOICE_SERVICE_TOKEN`  | empty                                | Shared internal token between Node and Python services; set it in production |

### Reliability controls

| Variable                 | Default | Description                      |
| ------------------------ | ------: | -------------------------------- |
| `LLM_CONCURRENCY`        |     `1` | Parallel local LLM requests      |
| `VOICE_QUEUE_LIMIT`      |     `8` | Maximum pending voice/model work |
| `VOICE_QUEUE_TIMEOUT_MS` | `15000` | Maximum queue wait               |
| `STT_TIMEOUT_MS`         | `60000` | Transcription timeout            |
| `TTS_TIMEOUT_MS`         | `15000` | Synthesis timeout                |
| `AUDIO_RETENTION_DAYS`   |    `30` | Recording retention window       |

See [`.env.example`](.env.example) for every setting, including backups and external CRM integrations. Never commit `.env` or encryption keys.

## Running the application

### Development

```powershell
pnpm dev
```

The development server uses Vite and automatically reloads TypeScript changes. The speech, TTS, MySQL, and Ollama services must already be running.

### Production build

```powershell
pnpm build
pnpm start
```

The production server serves the compiled React application and API from one process. The included [`ecosystem.config.cjs`](ecosystem.config.cjs) can run the Node and Python services with PM2 after PM2 is installed and `PYTHON_PATH` is configured.

### Health endpoints

| Endpoint                  | Authentication | Meaning                                |
| ------------------------- | -------------- | -------------------------------------- |
| `GET /api/health/live`    | Public         | Node process is accepting requests     |
| `GET /api/health/ready`   | Public         | MySQL, Ollama, STT, and TTS are ready  |
| `GET /api/health/details` | Required       | Dependency state and queue utilization |

## Salesforce and HubSpot

### Salesforce

The Salesforce connector demonstrates a focused enterprise integration:

- OAuth authorization-code flow with PKCE.
- One Salesforce connection per local CRM user.
- Contact search with duplicate choices.
- Directly linked open tasks through `Task.WhoId`.
- English and Malay typed or spoken lookup.
- Read-only behavior; it does not change Salesforce records.
- Optional AES-256-GCM token persistence with `SALESFORCE_TOKEN_ENCRYPTION_KEY`.

Follow the complete walkthrough in [`SALESFORCE_SETUP.md`](SALESFORCE_SETUP.md).

### HubSpot

HubSpot uses an account-wide private-app token and is restricted to local administrators. The import workflow previews a page before applying it, detects changed pages with a fingerprint, and requires acknowledgement before updating linked records. Sync operations are explicit and record their outcome. Uncertain create results must be reconciled with the real HubSpot record ID before retrying.

Set `HUBSPOT_ACCESS_TOKEN` only on the server. Startup never automatically imports or exports records.

## Security and privacy

```mermaid
flowchart TB
    Request[Browser request] --> Origin[Host and origin validation]
    Origin --> Rate[Rate and size limits]
    Rate --> Session[HTTP-only signed session]
    Session --> Role[User or administrator authorization]
    Role --> Owner[Owner-scoped database query]
    Owner --> Validate[Zod and domain validation]
    Validate --> Action[Read or reviewed transaction]
    Action --> Audit[Audit and latency record]
```

Implemented safeguards include:

- HTTP-only signed session cookies and session-version revocation.
- Password hashing with bcrypt.
- Trusted host/origin checks, request limits, and authenticated recording playback.
- Owner checks on CRM reads, proposals, recordings, and confirmations.
- Server-only CRM credentials and encrypted Salesforce token storage when configured.
- Loopback binding for model services and optional internal service-token authentication.
- Bounded queues, timeouts, cancellation propagation, and generic unexpected-error responses.
- Single-use, owner-restricted speech audio URLs with short-lived in-memory storage.
- Human confirmation before voice-initiated writes.

Recordings and ordinary MySQL rows are not application-level encrypted at rest. Use operating-system disk encryption, restricted database accounts, private service networking, HTTPS for non-local access, and encrypted backups. Obtain consent before recording people and define retention rules that fit the applicable privacy laws and company policy.

## Performance and cost

### Speech model bake-off

Use one JSONL manifest for every English or Malay model candidate. Each row contains an audio path, reference transcript, language, and optional CRM entities. Start from `evaluation/speech-manifest.example.jsonl`, replace the example paths with consented test recordings, and run:

```powershell
.\.venv\Scripts\python.exe scripts\evaluate_speech.py evaluation\speech-manifest.jsonl --token $env:VOICE_SERVICE_TOKEN --output evaluation\speech-bakeoff.json
```

The report includes word error rate, CRM entity accuracy, request p50, request p95, and per-file hypotheses. Compare candidates on the same machine and audio set. Promote a Malay streaming model only when it improves latency while preserving entity accuracy.

The live English path applies owner-scoped CRM vocabulary correction to names and companies and returns Vosk confidence. Low-confidence text is marked for human review before any CRM action.

The speech and language stack has no per-request AI API charge. Costs come from the computer or server, electricity, storage, maintenance, and any optional external CRM plan.

Measured development results are stored under [`evaluation/`](evaluation):

| Check                               |           Observed result | Scope                                                  |
| ----------------------------------- | ------------------------: | ------------------------------------------------------ |
| English Vosk first partial text     | 750 ms of synthetic audio | Local synthetic speech; not browser end-to-end latency |
| Vosk median frame processing        |                 111.55 ms | 250 ms frames on the development machine               |
| English Piper synthesis             |                    353 ms | One short synthetic request                            |
| Malay eSpeak synthesis              |                     12 ms | One short synthetic request                            |
| Whisper small English transcription |                     3.6 s | 2.55 s synthetic clip                                  |
| Whisper small Malay transcription   |                     2.3 s | 3.42 s synthetic clip                                  |

These measurements do not establish production p95 latency or real microphone accuracy. The English sample confused a name, and the Malay sample contained several substitutions. Evaluate consented recordings with expected accents, names, noise, microphones, and concurrency before setting an accuracy or latency target.

To reduce latency:

- Select the known speech language instead of automatic detection.
- Keep Ollama and both Python services warm.
- Use Vosk for continuous English dictation.
- Use Whisper `small` + CPU `int8` as the initial Malay/fallback balance.
- Use a supported GPU for faster-whisper if Malay latency is a priority.
- Keep spoken answers concise so the first TTS chunk begins quickly.

## Testing and quality checks

```powershell
# Server and domain tests
pnpm test

# React component tests
pnpm test:client

# TypeScript
pnpm check

# Production bundles
pnpm build

# Synthetic intent evaluation; does not write CRM data
pnpm voice:evaluate
```

The automated suites cover authentication, user isolation, action transactions, retry behavior, grounded responses, live-speech framing and finalization, HTTP protections, Salesforce token storage, HubSpot adapters, date handling, and interface behavior. The live HubSpot health test is opt-in with `RUN_LIVE_HUBSPOT_TESTS=1` because it contacts the configured account.

Automated tests do not replace these release rehearsals:

1. Record real English and Malay microphone samples.
2. Confirm English words appear during speech and the final microphone tail is retained.
3. Test names, mixed-language terms, noisy rooms, pauses, and long commands.
4. Verify a proposed write cannot save before human confirmation.
5. Exercise the configured Salesforce/HubSpot account with fictional records.
6. Restore an encrypted backup into a separate empty recovery database.

## Operations and deployment

- Use one Node instance with the current in-memory live-session store, audio cache, and rate limiters.
- For multiple replicas, move sessions, short-lived audio, rate limits, and refresh locking into shared infrastructure.
- Put a reverse proxy in front of the Node server for network access, terminate HTTPS, preserve `Host`, and disable buffering for `/api/voice/respond`.
- Set `APP_ORIGIN` to the exact public origin and enable `TRUST_PROXY=1` only behind the intended proxy.
- Keep MySQL, Ollama, port 8001, and port 8002 inaccessible from the public network.
- Configure service restart and log rotation. Do not expose the Vite development server publicly.
- Run retention and encrypted backups on a schedule appropriate for your data policy.

Detailed backup, restore, failure recovery, and release procedures are in [`PRODUCTION.md`](PRODUCTION.md).

Useful maintenance commands:

```powershell
# Preview expired recording/metric cleanup
pnpm retention

# Apply cleanup
pnpm retention --apply

# Create and verify an encrypted backup
pnpm backup C:\secure\localvoice-backup --quiesced
pnpm backup:verify C:\secure\localvoice-backup
```

## Troubleshooting

### `Port 3000 is already in use`

Another development or production CRM server is running. Stop that process, or change both `PORT` and `APP_ORIGIN`. Do not run `pnpm dev` and `pnpm start` simultaneously on the same port.

### Readiness returns HTTP 503

Sign in and inspect `/api/health/details`, or check each dependency:

- MySQL accepts `DATABASE_URL`.
- `ollama list` contains the exact `OLLAMA_MODEL`.
- `http://127.0.0.1:8001/health` is served by `whisper_server.py`.
- `http://127.0.0.1:8002/health` is served by `tts_server.py`.

### English produces another language

Choose **English — live dictation** in the Voice workspace. English is also the server fallback when a speech-language header is absent. If the UI says transcription will happen after Stop, verify the Vosk directory and confirm the speech-service health response contains `"english_dictation": true`.

### Dictation is delayed

The UI must show **Listening — English dictation**. If it shows recording-only fallback, live dictation did not start. Check browser microphone permission, AudioWorklet support, speech-service health, CPU saturation, and authenticated health details. Vosk interim text changes as additional audio clarifies earlier words.

### Malay transcription is slow or inaccurate

Malay uses Whisper phrase decoding rather than Vosk word streaming. Select Malay explicitly, speak in short phrases, verify FFmpeg is installed, and test a larger model or GPU only after measuring the speed/accuracy tradeoff on your hardware.

### Speech is silent

Confirm `tts_server.py` is running and `PIPER_VOICE` points to both the `.onnx` model and its adjacent JSON configuration. Browsers may require one user interaction before allowing audio playback.

### Salesforce callback mismatch

Use the exact callback displayed by the application. `localhost` and `127.0.0.1` are different cookie origins. Keep the Salesforce callback, `APP_ORIGIN`, and opened browser URL consistent.

### Database migration fails

Run `pnpm db:migrate` without `--apply` to inspect the plan. Migrations intentionally stop on ownership conflicts or duplicate external IDs. Repair those records explicitly and never edit an already-applied migration.

## Project structure

```text
localvoice-crm/
├── client/                    React application and microphone pipeline
│   ├── public/                AudioWorklet and public assets
│   └── src/
│       ├── components/        CRM, voice, Salesforce, and HubSpot UI
│       └── lib/               tRPC client and live transcription
├── drizzle/                   MySQL schema and migrations
├── evaluation/                Intent and speech measurement artifacts
├── models/                    Local Vosk/Piper model files
├── scripts/                   Migration, backup, retention, evaluation
├── server/                    API, CRM domain logic, integrations, tests
│   └── _core/                 Auth, environment, speech, LLM, health
├── shared/                    Shared schemas and speech utilities
├── streaming_dictation.py     Persistent Vosk session implementation
├── whisper_server.py          faster-whisper and Vosk FastAPI service
├── tts_server.py              Piper and eSpeak NG FastAPI service
├── voice_runtime.py           Bounded Python model worker
├── SALESFORCE_SETUP.md        Salesforce learning walkthrough
└── PRODUCTION.md              Operations, recovery, and release guide
```

## Limitations and roadmap

Current limitations:

- Vosk provides responsive English dictation but has lower name accuracy than larger models.
- Malay uses phrase-level Whisper updates and is not yet instant word-by-word dictation.
- The Malay eSpeak voice is lightweight but less natural than a neural voice.
- Live speech sessions and synthesized audio are held in one Node process.
- Salesforce is read-only and limited to contact lookup plus directly linked open tasks.
- HubSpot uses an administrator-held account token rather than per-user OAuth.
- Real microphone accuracy, concurrency, restore recovery, and external CRM behavior require deployment-specific validation.

Suggested next improvements:

1. Add a Malay streaming ASR model and evaluate it with a consented Malaysian speech set.
2. Add custom vocabulary or contact-name biasing for Vosk/Whisper.
3. Add WebSocket transport after measuring whether it improves browser-to-server overhead on the target network.
4. Move live sessions, audio cache, and throttling to shared services for horizontal scaling.
5. Add OpenTelemetry traces and deployment dashboards for p50/p95/p99 latency.
6. Add a higher-quality open-source Malay neural voice after checking its model and dataset licenses.
7. Run automated browser microphone tests with prerecorded virtual audio in CI.

## Competitive research

See [`COMPETITIVE_ANALYSIS.md`](COMPETITIVE_ANALYSIS.md) for the comparison with Salesforce Agentforce Voice, HubSpot Conversation Intelligence, Dialpad AI, LiveKit Agents, and open-source streaming speech projects. It includes a latency budget, prioritized engineering gaps, and a phased enhancement plan.

## License

Application code is licensed under the [MIT License](LICENSE). Dependencies and model files retain their own licenses. Review and preserve the applicable notices before redistribution, especially for:

- [Vosk](https://github.com/alphacep/vosk-api) and the selected Vosk model.
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) and the selected Whisper model.
- [Piper](https://github.com/OHF-Voice/piper1-gpl) and its voice model.
- [eSpeak NG](https://github.com/espeak-ng/espeak-ng).
- Ollama and the selected language model.

External CRM data remains subject to the Salesforce or HubSpot account terms and the data owner's policies.
