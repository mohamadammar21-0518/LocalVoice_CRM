# Local release verification — 16 October 2026

## Outcome

The rebuilt private deployment is running at https://localhost:3100/. App, MySQL, speech and TTS containers are healthy. This is a verified local release candidate, not certification of every browser interaction, perfect speech accuracy, or public-production readiness.

## Changes in this release check

- Fixed HubSpot voice role-guard ordering and updated token-isolated regression tests.
- Excluded private environment files, training data, model-training environments, and certificate/key files from the appropriate Git/build contexts.
- Fixed clean speech/TTS builds: Python 3.12 for pinned dependencies, FFmpeg for audio conversion, non-root service users and authenticated health checks.
- Gave staging its own speech/TTS services, model cache and network. It no longer relies on the old `localvoice-crm1` speech services. Existing databases, credentials and legacy containers were preserved.
- Standard Compose now waits for migrations and healthy dependencies; fixed its MySQL health-command environment expansion. Both Compose configurations validate. The standard stack was not separately deployed over existing data.
- Added repeatable isolated local CRUD, sign-out and synthetic speech acceptance in `scripts/check-components.mjs`.

## Verified

| Check | Result |
| --- | --- |
| Server tests | 128 passed; 1 optional integration test skipped |
| Client component tests | 49 passed |
| TypeScript and production bundle | Passed in clean Docker builds |
| Docker deployment | Four long-running services healthy; migration job exited successfully |
| HTTPS/authentication | Login, cookie flags, readiness, unauthenticated voice rejection and foreign-origin rejection passed |
| Concurrent reads | 10 authenticated workspace reads passed; 292 ms for that batch, not a capacity benchmark |
| Local workflows | Contact create/read/update/delete, notes, follow-up create/edit/complete/reopen, owner isolation, cascade cleanup and session revocation passed |
| CRM Studio | Database isolation, concurrent approval idempotency, persisted versions, rollback, training privacy/consent and soft deletion passed |
| Synthetic English audio | Correctly transcribed “Show my open tasks.”; synthesis 487 ms and transcription 6409 ms in this run |
| Live-call API | Local and Salesforce start/greeting/end; general question answered without a CRM change; TTS audio generated |
| Salesforce | Account, Contact, Opportunity, Task, Lead and Case catalog access verified; signed-in contact list loaded in Chrome |
| HubSpot | Contacts, companies, tasks, notes, calls and meetings readable; contact detail and custom-object catalog checked |
| Backup rehearsal | Encrypted backup restored into separate `restore_check_1792137522728`; all 14 tables and row counts matched; source unchanged |
| Dependency audit | 0 critical/high/moderate, 1 low KaTeX advisory; not an OS-image security audit |

Acceptance accounts/workspaces created by the isolated tests were removed. The encrypted backup and separate recovery database were retained for inspection. Audio-file restoration and logging into a restored app were not tested.

## Remaining limits and user acceptance

- HubSpot token permissions still deny deals, tickets, emails, products, line items and quotes (HTTP 403). Grant the appropriate scopes and account entitlements in HubSpot. Private-token mode is configured; per-user HubSpot OAuth login is not configured.
- One Salesforce catalog request returned a generic HTTP 500 immediately after deployment. A subsequent complete read-only run passed. This transient failure was not conclusively diagnosed; do not describe Salesforce availability as guaranteed.
- Real microphone quality, accents, Malay accuracy, continuous talking, interruption/barge-in and sustained call latency still need human acceptance. Synthetic speech is not evidence of perfect dictation. Staging uses CPU Whisper tiny, not large-v3.
- No fine-tuning job was run. Collect consented, reviewed transcripts and evaluate a candidate before replacing any model.
- External Salesforce/HubSpot/Twenty writes were not performed against customer records. Twenty end-to-end behavior was not revalidated in this release check.
- Chrome displayed the Voice screen and Salesforce contacts successfully. Other pages were not exhaustively visually checked because the user resumed using Chrome. Automated component/API checks do not replace a full responsive-browser pass.
- Address the remaining KaTeX advisory and complete the public-release gates in STAGING.md before public/customer production use.

## Repeat checks

Run from the repository with Docker and host Ollama running:

```powershell
docker compose --env-file .env.staging -f docker-compose.staging.yml up -d --build
node --use-system-ca scripts/check-staging.mjs
node --use-system-ca scripts/check-components.mjs --run --voice
node --use-system-ca scripts/check-call-hubspot.mjs
docker exec localvoice-staging-app-1 node --import tsx scripts/smoke-studio.ts --run
```

Keep `.env.staging`, `.env.docker`, certificate files and backup encryption keys private. Never use `down -v` for a normal stop. Refresh Chrome after deployment to load the current bundle.
