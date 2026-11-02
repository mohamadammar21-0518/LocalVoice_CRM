# CRM Studio: implementation and activation

CRM Studio extends LocalVoice; it does not replace the existing contacts or Salesforce screens. Open **CRM Studio** from the application navigation after restarting the app with the new build.

## Implemented

- Sales, property and recruitment templates; editable objects/fields, schema validation, version history, import/export and local-model schema generation.
- Local MySQL records, relationships, workspace membership (owner/editor/viewer), audit history and reviewed create/update/delete proposals.
- Typed or recorded English/Malay requests produce a proposal, not an automatic write. Select the exact record before updates/deletes. Delete confirmation requires `DELETE`.
- Record changes and local receipts commit together. Concurrent confirmations are idempotent; stale record versions are rejected.
- Remote adapters for Twenty, Salesforce and HubSpot; explicit object/field mapping, schema inspection and reviewed writes. Failed remote writes become uncertain and must be checked before attempting another operation.
- Twenty custom-object provisioning with preview, ownership markers and step receipts. Email/select fields currently use Twenty TEXT storage with Studio validation.
- Workspace-scoped MCP at `/api/mcp`: schema, search, receipts and optional drafting. No MCP execution/confirmation tool. Tokens expire and are bound to the issuing login session; issue/revoke them in Studio.
- Training Lab for reviewed command labels and corrected speech transcripts. Local export, grouped splits, inference evaluation, LoRA recipes and candidate-model conversion instructions are in [training/README.md](training/README.md).

## Credentials and services needed later

Keep secrets in local environment files or your deployment secret manager, not chat messages or Git.

1. **Local demo:** existing MySQL, Ollama and speech services. Back up before migrations; use `pnpm db:migrate` for preview, then `pnpm db:migrate --apply`. Start with `pnpm dev` or rebuild and restart your existing service. Previously running processes do not automatically load a production build.
2. **Twenty:** start a separate tested Twenty release, create its workspace and API key, then set `TWENTY_API_URL`, `TWENTY_API_KEY` and `TWENTY_WORKSPACE_ID` (the **LocalVoice Studio workspace UUID** allowed to use that connection). Optional `docker-compose.twenty.yml` needs Docker Desktop running and a private `.env.twenty` containing `TWENTY_IMAGE`, `TWENTY_DB_PASSWORD`, `TWENTY_ENCRYPTION_KEY`. Pin a tested image tag/digest. Start using `docker compose --env-file .env.twenty -f docker-compose.twenty.yml up -d`. Review the current upstream deployment requirements before exposing this service.
3. **Salesforce:** configure the existing OAuth integration using [SALESFORCE_SETUP.md](SALESFORCE_SETUP.md), connect the user, then inspect/map objects in Studio. Test in a sandbox organization first.
4. **HubSpot:** configure the existing private-app token and `HUBSPOT_STUDIO_WORKSPACE_ID`, then inspect/map the allowed fields. Test in a test account first.
5. **MCP client:** use the Studio-issued bearer token with the app's `/api/mcp` URL. Use HTTPS outside loopback. Draft permission still requires human confirmation inside Studio.
6. **Training:** collect permissioned, human-reviewed examples for both tasks. Export locally, establish a held-out baseline, and run the documented recipes on suitable training hardware. No training job, paid GPU rental or dataset upload happens automatically.

## Verified on the development machine

- TypeScript check and production build pass.
- Server suite: 93 tests passed; one live HubSpot test skipped.
- Existing client suite: 48 tests passed. This is regression coverage, not a complete visual/accessibility audit of Studio.
- Dataset preparation: four Python tests passed.
- Additive database migrations applied successfully without deleting existing CRM rows.
- `node node_modules/tsx/dist/cli.mjs scripts/smoke-studio.ts --run` passed real-MySQL checks for workspace isolation, concurrent confirmations, persisted versions, rollback, training privacy/consent and soft deletion. It creates temporary fixtures and removes only those exact fixtures afterward.

## Remaining limits / not production certification

Live Twenty provisioning and remote CRM writes still require credentials and end-to-end testing. Twenty has not been started on this machine. The integrations are not a background bidirectional synchronization engine. Remote browsing is currently first-page limited; complex composite provider fields need additional adapters. Remote pre-write comparison is not a provider-side atomic compare-and-swap.

Use Studio's voice review flow for custom objects; legacy voice batches deliberately cannot execute Studio actions across transaction boundaries. A crashed remote operation/provisioning run may need administrator inspection and recovery; never blindly retry it. Workspace records are loaded in memory with a 10,000-record local limit; this is not a large-tenant implementation.

No model has been fine-tuned yet. GPU recipe execution, candidate quality and mixed-language accuracy remain unverified. Whisper training does not change the separate Vosk live-English model or TTS. Retain old model versions for rollback.

Twenty is an independently licensed upstream project, not a collection of unrestricted templates. This integration uses its APIs; review upstream license obligations before distributing modified Twenty code or a hosted product. Production rollout still needs security review, backup/restore testing, monitoring, deployment hardening and organization-specific access checks.
