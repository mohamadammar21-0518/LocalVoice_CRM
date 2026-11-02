# Live call and HubSpot workspace

Open Voice and choose **Open live call**. Dictation, audio uploads and the existing
review screens remain available through **Back to dictation** after ending a call.

Start call opens one microphone connection. A brief pause ends a request, while
the microphone stays connected during the assistant's speech and processing.
Starting to speak interrupts playback. Use headphones: browser echo cancellation
helps but does not guarantee that loud speakers or background noise will never
trigger interruption. Mute discards an unfinished utterance; End call releases
the microphone and stops playback. A single request has a 110-second limit.

The local CRM option reads contacts, notes and follow-ups and proposes local notes
and follow-ups. Choose **HubSpot — live records** to read and change HubSpot CRM
records using the existing private-app connection. Local + imported HubSpot mode
retains the existing local write behavior; it is not a universal two-way sync.

Changes are read aloud with their target and fields. Say **confirm change** after
the full readback. A HubSpot archive requires **confirm delete**. Say **cancel
change**, **repeat**, or give a correction instead. An interrupted readback,
expired proposal or an unrelated “yes” cannot approve a change. Corrections
invalidate the previous approval. HubSpot writes with uncertain network outcomes
are not automatically retried; inspect the remote record before preparing another.

Call context lives in server memory and expires after 30 minutes of inactivity.
Restarting the server ends calls. Recordings use the same private storage and
retention behavior as existing dictation. No training or external audio upload is
started by call mode. The local streaming decoder handles English; Malay uses
the completed-utterance Whisper path and has higher latency.

The **HubSpot** sidebar opens a live record workspace for contacts, companies,
deals, tickets, tasks, notes, calls, emails, meetings, products, line items and
quotes. Custom objects are discovered when schema access is available. Records
are paged; selecting one retrieves its property definitions and property values,
including custom fields. Linked records have their own paginated view. Create,
edit and archive operations require a review and explicit confirmation.

Access depends on the private app's object read/write and schema scopes and the
HubSpot subscription. Sensitive fields require additional scopes where supported.
The CRM workspace is not a complete HubSpot account export: marketing content,
files, automation, inbox conversations and administrative settings have separate
APIs. The call planner currently understands standard object names; use the
workspace for custom-object inspection and changes.

Checks:

```powershell
node --use-system-ca scripts/check-staging.mjs
node --use-system-ca scripts/check-call-hubspot.mjs
```

These smoke checks log in locally, exercise a temporary call and speech synthesis,
and inspect HubSpot reads/permissions. They never create, edit, delete or import
CRM records and never log out the account.

API references: [HubSpot object APIs](https://developers.hubspot.com/docs/api-reference/legacy/crm/using-object-apis)
and [HubSpot property metadata](https://developers.hubspot.com/docs/api-reference/legacy/crm/properties/guide).
