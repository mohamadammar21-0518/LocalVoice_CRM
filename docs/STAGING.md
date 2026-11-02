# Private staging

This deployment binds only to loopback and is accessed at **https://localhost:3100/**. It stays local/private: no hosting account, domain or public ports are needed. It is not a public production release. Use the locally trusted certificate; do not disable certificate verification. The in-app browser may not trust the Windows local certificate even when Chrome does.

## Access and lifecycle

- Username: `staging_admin`.
- Password: `LOCAL_ADMIN_PASSWORD` in the git-ignored `.env.staging`. Never share this file or commit it.
- Existing development app: http://localhost:3000 (separate database).
- Existing integration configuration is loaded from `.env.docker` and overridden by `.env.staging`. Never commit either file.
- Staging now owns its speech and TTS services and private Docker network; it no longer needs `localvoice-crm1` speech containers. Ollama still runs on the host, and Twenty remains a separate optional stack. Four long-running services (app, database, speech, TTS) plus a one-shot migration job are intentional.
- Speech defaults to Whisper `tiny` on CPU for the existing latency profile. Set `STAGING_WHISPER_MODEL_SIZE=small` in `.env.staging` and recreate speech to trade more latency for potential accuracy improvement. Model downloads persist in the speech-cache volume. No model is automatically fine-tuned.

From the repository directory:

```powershell
# Only on first setup; refuses to overwrite existing secrets.
node scripts/prepare-staging.mjs

docker compose --env-file .env.staging -f docker-compose.staging.yml up -d --build
node --use-system-ca scripts/check-staging.mjs
docker compose --env-file .env.staging -f docker-compose.staging.yml ps

# Stop without deleting data or volumes.
docker compose --env-file .env.staging -f docker-compose.staging.yml stop
```

Do not add `down -v`: that deletes staging data. Do not regenerate the password file while retaining a database volume. The database has no host-published port. Preserve the TLS certificate, encryption keys, database, recordings and token volumes together.

## Acceptance tools

`check-staging.mjs` checks the production page, security headers, readiness, login, cookie flags, unauthenticated voice rejection, foreign-origin mutation rejection and ten concurrent authenticated workspace reads. That is a smoke test, not a production capacity benchmark.

```powershell
docker exec localvoice-staging-app-1 node --import tsx scripts/smoke-studio.ts --run
node --import tsx scripts/staging-recovery.ts
node --use-system-ca scripts/check-components.mjs --run --voice
node --use-system-ca scripts/check-call-hubspot.mjs
```

The CRM smoke test creates isolated users/workspace and removes only its fixtures. The recovery drill encrypts the staging database, authenticates the backup before importing SQL, creates a separate `restore_check_*` database, and compares table names and row counts. It leaves that recovery database and encrypted artifact for inspection. It does not restore over the source and does not test audio-file recovery or login against the restored database. Keep backup keys separately from backups before actual production use.

## Public release gates

- Select hosting and a domain. Configure publicly trusted HTTPS, a reverse proxy, secure cookies, explicit origins, and restricted network ingress. Do not expose this local staging port publicly.
- Review and resolve dependency advisories; an advisory audit is not a complete security assessment.
- Run a complete recording/backup/recovery rehearsal and login against the restored application.
- Test real microphone input, English/Malay transcription and playback with reviewed CRM actions.
- Connect dedicated Salesforce/HubSpot test accounts and verify writes; existing customer data has not been used for write tests.
- Measure realistic authenticated multi-user workloads, latency percentiles and resource limits.
- Configure protected off-machine backups, monitoring, retention, patching and a rollback process.

## Verification record (13 October 2026)

- Fresh staging migrations: 53 statements applied; subsequent runs adopted the existing schema without deleting CRM rows.
- App process runs as UID 1000, not root. The database has no host-published port.
- Initial live checks passed for login, readiness, HTTP security headers, cookie flags, unauthorized voice requests and foreign-origin requests. App restart followed by login/readiness checks passed.
- Isolated database smoke passed: owner isolation, concurrent confirmation idempotency, versions, rollback, training consent/privacy, and soft deletion. Only its own fixtures were removed.
- Encrypted database recovery: 14 tables restored to `restore_check_1791826772184`, with matching table names and row counts and one admin account. The source database was not overwritten. Encrypted artifact is under `.localvoice-private/staging-backups/restore_check_1791826772184/`; decrypted temporary SQL was removed.
- Dependency updates preserved the existing wouter patch by pinning its required version. Production dependency audit: 0 critical, 0 high, 0 moderate, 1 low (KaTeX; reported patched version >=0.18.2). This is a production-dependency audit, not a container OS or full dev-tool audit.
- After production dependency updates: 99 server tests passed (one optional integration skipped), 48 client tests passed. After the final Drizzle security upgrade: 27 focused CRM/transport tests passed.
- Patched-image live acceptance: ten concurrent authenticated workspace reads passed (172 ms for that batch; not a capacity guarantee), and the isolated database smoke passed again.
- The synthetic voice acceptance test initially exposed missing FFmpeg in the speech Docker image. The speech image now installs FFmpeg; its health check also verifies audio-converter availability. Synthetic checks do not replace microphone and English/Malay accuracy testing.
- After rebuilding speech, the synthetic reviewed workflow passed: TTS 488 ms, transcription 1546 ms, command planning 11984 ms in that run, confirmed local write and read-back. Workspace: `88f987ed-1e5b-4b12-a192-6967edd3550c`. No transcript correction was needed in the successful run. An earlier run misrecognized the company name and stopped before any CRM write; do not treat this as an accuracy guarantee or a latency SLA.
- Docker readiness probe uses Node HTTP with the configured origin's Host header. The earlier fetch-based probe did not transmit the override as intended and hit the application's Host protection. Host validation remains enabled.
