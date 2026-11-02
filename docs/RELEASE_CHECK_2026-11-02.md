# Release verification — 2 November 2026

The current source passed frozen installation, TypeScript, 131 server tests (one optional live test skipped), 49 client tests, and a production build. Four Python preparation tests passed. Production dependency audit reported no known vulnerabilities. All three Compose files validated, and the release workflow passed actionlint.

A disposable MySQL 8.4 database applied 53 migration statements and a second preview required none. The built API passed administrator login, cookie issuance, authenticated dashboard access, and anonymous contact-read rejection. The temporary database was removed. The CI health probe was changed to TCP to avoid detecting MySQL's temporary initialization server as ready.

Existing staging containers passed contact, note and task CRUD, owner isolation, cascade deletion, session revocation, ten concurrent authenticated reads, cookie and origin security checks, and readiness. Synthetic English TTS took 859 ms and transcription 2086 ms in one run. Studio checks passed isolation, concurrent confirmation idempotency, versioning, rollback, consent/privacy and soft deletion. Fixtures were removed. These checks exercised the existing staging images; they are distinct from tests of the changed source and do not validate a new public deployment.

The latest semantic-search change bounds Ollama embedding requests to a shared three-second deadline and validates vectors, allowing regular search fallback. It does not establish a measured end-to-end voice speedup.

Public hosting and domain are not chosen. No external sandbox CRM accounts are available. Public TLS, managed secrets, production monitoring, restore rehearsal, representative load tests and real English/Malay microphone acceptance remain deployment gates. Multi-replica operation remains unsupported. The large-module refactor is partial. A successful local suite does not remove these gates.
