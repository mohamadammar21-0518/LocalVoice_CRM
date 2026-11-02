# Project diagnostic — 31 October 2026

## Current condition

LocalVoice and optional Twenty were started from their existing Docker images without deleting volumes. The LocalVoice app, MySQL, speech, and TTS containers are healthy at `https://localhost:3100/`. Twenty server, PostgreSQL, and Redis are healthy at `http://localhost:3001/`; its worker is running. No AWS deployment was found or performed in this diagnostic.

The worktree has 108 modified/untracked paths and `main` is eight commits ahead of `origin/main`. Do not treat the current remote Git branch as a complete copy of the working application. Private `.env` files are ignored by Git.

## Tests performed today

| Area | Result |
| --- | --- |
| TypeScript | `tsc --noEmit` passed |
| Server tests | 128 passed, 1 optional test skipped |
| Client tests | 49 passed |
| Production build | Vite and esbuild passed |
| Compose configuration | Local, staging, and Twenty configurations validated |
| Local HTTPS/auth | Page, readiness, login, cookie flags, unauthenticated rejection, foreign-origin rejection, and 10 concurrent authenticated reads passed (633 ms batch) |
| Local CRUD | Contacts, notes, follow-ups, owner isolation, deletion and sign-out/session revocation passed; test account removed |
| CRM Studio | Isolation, concurrent approval idempotency, versions, rollback, training privacy/consent, soft deletion passed; fixtures removed |
| Speech | Synthetic English TTS 782 ms, transcription 1638 ms, correct transcript; real microphone and accents not tested |
| Command planner | Three fictional English/Malay commands exact and valid; model times 2566, 917 and 1125 ms; no CRM writes |
| Salesforce | Connected; Account, Contact, Opportunity, Task, Lead and Case catalog reads passed; live-call greeting/end passed |
| HubSpot | Connected; contacts, companies, tasks, notes, calls and meetings read; contact detail passed |
| Live call | Local/Salesforce start, greeting, end; one general question answered without write; audio generated |
| Ollama | Reachable from app container |
| Twenty | Started and healthy; the app read 44 remote object definitions |
| Dependency audit | 0 critical, 3 high, 3 moderate, 3 low advisories in production dependencies |

The app log includes one historical startup database-query error from **18 October**. Today's app container has zero restarts, a successful startup, and healthy status. The cause of that older event was not established.

## Priority work before an external deployment

> **Resolved 2 November 2026:** production dependencies were updated and the unused `streamdown` and `@hookform/resolvers` trees were removed. `pnpm audit --prod` now reports zero vulnerabilities. The runtime image now installs production dependencies only and removes npm/Corepack after the build; a socket-free Trivy scan of the resulting image reported zero fixable high or critical vulnerabilities.

1. **Update audited dependencies and retest.** High findings affect `body-parser` (two affected major-version paths) and `follow-redirects`; moderate findings include `fast-uri` and `qs`. The low KaTeX finding remains. Update the lockfile carefully, then rerun audit, unit tests, build, and local smoke tests. An audit identifies vulnerable package versions; it does not by itself prove exploitability in this application. A container OS/image scan is also needed.
2. **Create a complete, reviewable Git release.** Preserve the current worktree, review all 108 changed/untracked paths, exclude secrets and generated data, commit the intended source, and push a release branch/tag. The remote branch does not presently contain the full working version.
3. **Finish HubSpot access.** The current private-app token receives HTTP 403 for deals, tickets, emails, products, line items, and quotes. Grant the relevant scopes and account entitlements, then test reads. Per-user HubSpot OAuth login is not configured (`HUBSPOT_CLIENT_ID` and `HUBSPOT_CLIENT_SECRET` are empty).
4. **Perform real interaction acceptance.** Test English and Malay microphones, accents/noise, continuous dictation, interruption/barge-in, playback, responsive screens, keyboard navigation, sign-out, and error recovery in a browser. API and synthetic audio checks cannot establish call-quality behavior.
5. **Test reviewed external writes on dedicated test records.** Salesforce, HubSpot, and Twenty create/edit/delete/approval behavior was not exercised against external records today. Use dedicated test accounts and labelled records, then verify read-back and cleanup.
6. **Prepare AWS-specific deployment.** Current Compose uses localhost ports/certificate and a Docker Desktop host-gateway address. Add a domain, trusted HTTPS, correct Linux model/Ollama connectivity, private networking, persistent storage, secure secrets, backups, restore rehearsal, monitoring, and capacity tests before public access.
7. **Train only with reviewed data.** No training run artifacts are present under `training/runs/`; no fine-tuned model is deployed. Collect consented, corrected command and speech examples; establish held-out English/Malay accuracy and latency baselines before training or replacing models.

## What was not established

No full responsive visual pass, real microphone call, external CRM write, sustained load test, current backup restoration, container image vulnerability scan, or AWS deployment was performed. The October 16 backup rehearsal remains historical evidence, not a test rerun today. The service is suitable for local development and controlled demos; the items above remain before customer production use.
