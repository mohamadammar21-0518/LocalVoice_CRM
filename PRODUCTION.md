# Production operations

## Current deployment

The local MySQL schema was migrated after an encrypted snapshot. Business record counts before and after matched: 1 user, 4 contacts, 4 interactions, 4 follow-ups, 28 voice sessions and 25 recordings. The recovery directory is .localvoice-recovery; latest-backup.txt identifies the snapshot and key.txt holds its key. Move the key into a separate secure store. Source before these changes is retained in .localvoice-backup. Backup authentication passed; a separate database restore rehearsal remains necessary.

The insecure JWT signing secret was rotated. Existing cookies need a fresh login. The existing database and HubSpot credentials were preserved. A read-only request to the configured HubSpot account returned HTTP 200. No automatic HubSpot import or remote writes were performed.

## Security and data boundaries

- Every local read, proposal, confirmation, recording and playback lookup checks the signed-in owner. Composite database foreign keys prevent linking a record to another owner's contact/session.
- Confirmations lock the session and contacts, require the stored proposal revision and commit a complete batch with an audit entry. Repeated identical confirmation returns the saved receipt. Changed retries conflict.
- Session versioning revokes sessions on logout, password reset and role changes. Password hashes and session versions are excluded from public user responses.
- API/upload access checks trusted host and origin, enforces limits, and uses HTTP-only cookies. Configure APP_ORIGIN exactly. HTTPS is required for non-local production access; only enable TRUST_PROXY behind the configured local proxy.
- Keep MySQL, Ollama and both Python services private. The Python services bind to loopback and optionally require VOICE_SERVICE_TOKEN; the installed workspace has a generated internal token.
- Stored recordings and CRM tables contain personal data. Protect the Windows account and data directories, use disk encryption and limit database privileges. The application does not encrypt ordinary database rows or uploaded recordings at rest.
- Browser network/session debug collection and external Google Fonts were removed. API responses use no-store. Models remain local after initial model downloads; optional HubSpot requests contact its cloud API.

## Runtime and scaling

The production app serves the built frontend. Persistent Whisper and Piper services each load their model once and serialize inference through bounded queues. The Node service limits model and voice concurrency, propagates cancellation and times out requests. Audio is delivered as authenticated binary WAV URLs with short expiry. Recording uploads are binary and limited to two minutes/16 MB.

Recording persistence runs alongside Whisper inference so local file I/O does not delay the start of transcription. Voice, Salesforce and HubSpot panels are loaded when opened, reducing the initial browser bundle. These changes remove avoidable app overhead; they do not make Whisper incremental or reduce the model's inference time. Measure first transcript latency on the target machine before selecting a smaller or GPU-backed model.

Automatic silence stopping is a browser heuristic. STT still processes a completed short recording; it is not incremental word-by-word streaming recognition. Model JSON is streamed internally for timing, then validated before retrieval and playback. Subsequent audio sentences are synthesized while preceding audio plays.

Use one Node instance with these in-memory audio queues and IP rate limits. Multiple replicas require a shared audio store, distributed throttling/queues and load balancing appropriate for streaming connections. Metrics currently summarize at most the latest 5000 samples; the UI reports truncation.

PM2 configuration is ecosystem.config.cjs. Install/configure PM2 separately before pnpm pm2:start; PYTHON_PATH must point to the virtual environment. Set the service manager to restart on machine boot and rotate logs. On Windows run services without visible helper windows. Do not expose the development server publicly.

For a reverse proxy, use HTTPS, preserve Host, disable buffering on /api/voice/respond, and allow request timeout beyond LLM_TIMEOUT_MS plus queued speech. Configure the application's origin and trusted proxy setting before opening the firewall. Backups and maintenance are manual scripts until a scheduler is configured.

## Backup and recovery

1. Stop application writes and retention. Ensure the database account can read all CRM tables and run mysqldump.
2. Generate a base64 32-byte BACKUP_ENCRYPTION_KEY in a secure store. Set MYSQLDUMP_PATH to the installed executable if it is not on PATH.
3. Run pnpm backup BACKUP_DIRECTORY --quiesced using a new empty directory. Database SQL and recording frames are gzip-compressed and AES-256-GCM authenticated/encrypted.
4. Run pnpm backup:verify BACKUP_DIRECTORY with the same key. This checks decryption/integrity, not full database recovery.
5. Create a separate empty recovery database, set RESTORE_DATABASE_URL and MYSQL_PATH, and run pnpm backup:restore BACKUP_DIRECTORY EMPTY_AUDIO_DIRECTORY --confirm-empty-target. The script refuses the live database and non-empty targets. It verifies all encrypted streams before executing SQL, then checks recording references.
6. For a pre-upgrade snapshot, point DATABASE_URL at the recovered database and apply current migrations before starting a staging app. Point LOCAL_STORAGE_PATH at its recovered recordings. Verify login, contact/task reads and playback there before promoting recovery.

MySQL DDL is not a transaction. Migration statement checksums support resuming after interruption. Never edit already applied migration SQL. Inspect partially restored targets before retrying. Keep an off-machine backup copy and conduct periodic restore rehearsals.

## HubSpot failure recovery

Preview every import page; changed fingerprints require another preview. Importing updates existing linked rows and may overwrite local edits after explicit acknowledgement. Remote deletion and general conflict merging are not automated.

Sync jobs persist success, failure and uncertain outcomes. Do not retry a running/uncertain create after a network error. Inspect HubSpot and reconcile the real remote ID. Note/task reconciliation requires the expected contact association. Contact reconciliation requires an administrator to verify identity. Reconciliation is available after an active request has had time to finish.

## Release checks

TypeScript and frontend/backend builds should pass. Existing automated coverage includes transaction rollback/replay, owner boundaries, queue cancellation, authenticated HTTP, model streaming, encrypted backup integrity, timezone conversion and HubSpot request construction. Run pnpm test when validating a release; live HubSpot tests are opt-in via RUN_LIVE_HUBSPOT_TESTS=1.

Synthetic planner evaluation is a small development check, not a production accuracy guarantee. Evaluate real English/Malay recordings, names, noisy microphones, duplicate contacts, mixed-language dates and concurrent use with a consented dataset. Set p95 latency and error budgets from hardware measurements. Deploy only after an end-to-end audio rehearsal and a separate backup restore rehearsal.

## Measured development results

The installed Gemma baseline passed 4/11 synthetic commands with 25.5-second median planner latency. The final hybrid parser plus qwen2.5-coder:1.5b passed 11/11: ten commands required no model inference; the complex batch took 7.7 seconds. This small corpus does not establish general accuracy.

English Piper synthesis took about 160 ms and Malay eSpeak synthesis about 14 ms for short commands. The existing medium Whisper model took about 6.7–6.8 seconds per synthetic short clip. English was recognized correctly; Malay had a first-word substitution (Tunjukkan became Tundukkan). Real microphone recordings and Malay pronunciation tuning are still needed. These are local development measurements, not end-to-end latency guarantees.

Live production HTTP checks passed readiness, authenticated login, a Malay response grounded in actual MySQL counts, streamed speech and authenticated binary playback. The default weak bootstrap/admin password was replaced; new credentials are in .localvoice-recovery/login.txt. Keep this file private and move credentials into a password manager.

The existing configured bootstrap account currently has the user role and there is no administrator. Administrator promotion requires user approval; until approved, shared HubSpot operations and the Users panel remain unavailable through the app.

## Additional reliability improvements

Salesforce connections can now survive restarts with a dedicated SALESFORCE_TOKEN_ENCRYPTION_KEY. The single-process store authenticates encrypted records against the owner and configured organisation/client. Refresh, save and disconnect are serialized per owner. OAuth callbacks re-check the local session after exchanging the authorization code. Read SALESFORCE_SETUP.md before key rotation or recovery; the database/audio backup does not contain this credential store.

Unexpected API failures return a generic message without database driver details or stack traces. Known validation and permission errors remain actionable. CRM reads wait for authentication and only run when their screen needs them; searches wait briefly for typing to pause. Contact and task save buttons disable during submission and failed mutations show a visible error. The overview always uses the first page of open tasks independently of follow-up filters.

Cancelled speech requests do not trigger another transcription attempt, and model timeouts do not automatically double inference work. Voice displays conversion, service queue and inference times when the speech backend reports them. Long speech is split without losing long words. Salesforce speaks up to five tasks and shows the retrieved list and truncation warning. These changes still require a completed recording; they do not implement live incremental transcription.

Validation for this update: 63 regression checks passed; the opt-in live HubSpot check was skipped. TypeScript and both production builds passed. The initial browser bundle remains approximately 701 KB minified (198 KB gzip), so Vite still reports its large-chunk advisory. The updated local app and speech services were started, and readiness returned HTTP 200 with MySQL, Ollama, Whisper and TTS available. This confirms service readiness, not an end-to-end microphone or live Salesforce rehearsal. Reconnect Salesforce once after this upgrade to create the encrypted record. Services were started as hidden local processes; automatic restart after reboot still requires the documented service-manager setup.
