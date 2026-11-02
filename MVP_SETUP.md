# Run and demonstrate the MVP

The MVP supports a local custom CRM, forms, reviewed voice commands, text/audio responses and reviewed training examples. External connections are optional. Placeholders are documented in `.env.example`; optional secrets are blank so unconfigured integrations remain inactive. Preserve your existing `.env` and add only missing settings.

## Credentials to prepare

| Service | Values needed | Where to enter them |
| --- | --- | --- |
| Local MySQL | Host, database, username and password | `DATABASE_URL` in `.env` |
| Local sign-in | Admin username and initial password | `LOCAL_ADMIN_USERNAME`, `LOCAL_ADMIN_PASSWORD` |
| Application security | Generated random session secret and internal voice token | `JWT_SECRET`, `VOICE_SERVICE_TOKEN` |
| Salesforce | OAuth app client ID, client secret and your org's login/My Domain URL | `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_LOGIN_URL` |
| Salesforce token storage | Generated 32-byte base64 encryption key | `SALESFORCE_TOKEN_ENCRYPTION_KEY` |
| HubSpot | Private-app access token with access to the CRM objects you intend to read/write | `HUBSPOT_ACCESS_TOKEN` |
| Twenty | Running instance URL and workspace API key with the required record/metadata permissions | `TWENTY_API_URL`, `TWENTY_API_KEY` |

Salesforce callback for the default local address is `http://localhost:3000/api/salesforce/callback`; this must match the registered OAuth app callback. The application requests `api refresh_token`. Sign into Salesforce through the app to authorize your own account; a Salesforce username/password is not stored in this configuration. Follow `SALESFORCE_SETUP.md` for the existing OAuth flow.

For HubSpot and Twenty, also set `HUBSPOT_STUDIO_WORKSPACE_ID` or `TWENTY_WORKSPACE_ID` to the **LocalVoice workspace UUID shown in Connections**. These are identifiers, not secrets. The current token configuration supports one assigned Studio workspace per provider. After adding credentials, restart the application and inspect/map the provider schema before using remote records.

Ollama, local Whisper, Piper and Vosk need no cloud API key. MCP tokens are generated inside Studio when needed. Fine-tuning on a local GPU needs no paid API credential; GPU-host credentials would be a separate choice later. The optional Twenty Docker installation also needs `TWENTY_IMAGE`, `TWENTY_DB_PASSWORD` and `TWENTY_ENCRYPTION_KEY` in `.env.twenty`.

Do not send secrets in chat or commit them. `.env.example` documents the missing slots; your working `.env` has not been overwritten. Changing `LOCAL_ADMIN_PASSWORD` does not change the password of an already initialized account: use the application's administrator password reset.

## Start on this Windows machine

Open PowerShell in `C:\Users\User\Downloads\localvoice-crm (1)`. Keep MySQL running. Use separate terminal tabs for these processes:

```powershell
ollama serve
```

```powershell
.\.venv\Scripts\python.exe whisper_server.py
```

```powershell
.\.venv\Scripts\python.exe tts_server.py
```

```powershell
node node_modules\pnpm\bin\pnpm.cjs dev
```

If Ollama is already running, use that process. Open http://localhost:3000 and sign in. Open CRM Studio to see the new service checks and walkthrough. The status panel checks whether the configured command model is installed as well as whether the services respond. Readiness does not by itself measure recognition accuracy.

## Five-minute demonstration

1. Choose the Sales template and create a workspace with a recognizable demo name.
2. Open Companies. Use the form to propose a fictional company called Nova Labs, review it and confirm.
3. Select that company. Type or speak an update matching a field shown in your schema. Review the proposal before confirming; verify the saved values in the table.
4. Try an ambiguous update without a selected record and verify that it asks for clarification. Every command is still validated against the schema.
5. Open Training and save a reviewed command example. Record a short English or Malay request and annotate its session with the corrected transcript and your permission to train on it.

Use local storage throughout this demo. Unconfigured external providers cannot be selected in Connections. Configuration present means settings exist; an OAuth authorization or successful provider API call is still required to establish connectivity.

## Current boundaries

Latest local activation checks: the application readiness endpoint returned HTTP 200; the saved Salesforce authorization successfully discovered objects including Account and Contact; HubSpot company schema and record reads passed. The `LocalVoice MVP Demo` workspace contains a fictional local company, and the HubSpot workspace assignment is saved. No external CRM records were changed by these checks.

Twenty's private `.env.twenty` was generated with a pinned `v2.45.0` image and independent random secrets. Docker recovered and the stack was started successfully: PostgreSQL, Redis and the server are healthy; the worker is running. Both `/healthz` and the HTML landing page return HTTP 200. Complete onboarding at http://localhost:3001, then generate a workspace API key in Settings → API & Webhooks (or MCP & APIs, depending on the UI). The API connection and provisioning still need that key and end-to-end validation. Preserve `.env.twenty` on later runs; `scripts/prepare-twenty.ts` never overwrites it. The Docker CRM uses `.env.docker`, so changes to `.env` alone do not update that deployment.

This is a development MVP. Live external CRM behavior needs account-specific testing after credentials are added. Full browser and microphone testing is still needed on your device. Training scripts exist, but no fine-tuning has run; see `training/README.md`. Background bidirectional CRM synchronization is not included. See `CRM_STUDIO.md` for detailed implementation limits and verification history.
