# Latency tuning — 12 October 2026

## Changes

- Shorter CRM command prompt: omit empty schema options/aliases and redundant instructions while retaining field types and validation rules.
- Request compact JSON. Tested outputs decreased from 75–76 tokens to 17–18 tokens.
- The server attaches the authenticated caller's selected record ID when an update/delete omits it. Conflicting model IDs still fail existing validation. Selection, workspace permissions, draft validation, stale-record checks and confirmation are unchanged.
- Debounce Studio record search by 250 ms to avoid a request on every keystroke.
- Keep training export and evaluation consistent with server-bound record selection.

## Local measurements

`node --import tsx scripts/benchmark-studio.ts` uses only fictional prompts and never writes CRM data. It verifies operation, object, exact values and selected-record binding.

| Command | Initial prompt | Optimized first run | Optimized warm repeat |
| --- | ---: | ---: | ---: |
| English create | 7.145 s | 3.951 s | 1.322 s |
| Selected-record update | 4.744 s | 2.387 s | 1.392 s |
| Malay create | 5.016 s | 2.286 s | 1.419 s |

The initial Malay run incorrectly chose update with a selected record. Both final optimized runs passed exact-value checks for all three cases. A three-command smoke test is not a broad model-accuracy evaluation. CPU contention and prompt caching affect timings; these are observations, not an SLA or controlled statistical benchmark.

These times cover model generation, not microphone capture, transcription, database access, remote CRM requests or playback. No customer records were changed for these benchmarks.

## Existing settings retained

The model already preloads on server startup with a 30-minute default residency. Speech uses a persistent faster-whisper process, CPU int8 by default, and beam size 1. No model was downloaded or replaced, concurrency increased, or recognition quality reduced. Review and confirmation remain mandatory.

For further tuning, measure real English/Malay recordings and the deployed machine's CPU/GPU utilization. Do not infer end-to-end latency from model-only timings. Use the production build for deployment rather than the development server; verify that deployment separately.
