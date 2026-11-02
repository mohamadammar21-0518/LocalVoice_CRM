# MVP verification — 12 October 2026

## Verified in the running application

- Signed-in access to CRM Studio at http://localhost:3000.
- Storage, command model, speech recognition and spoken-response services report ready. Health checks are not microphone accuracy tests.
- LocalVoice MVP Demo uses Twenty. Its provisioning receipt reports four custom objects, including relation fields, successfully created.
- Created fictional company `MVP Acceptance Demo` through form → review → confirm. Twenty returned a receipt and the company appeared in the list.
- Local model prepared an update of the selected demo company, changing only industry to `Quality assurance`. Confirmed in the browser and read back the changed value.
- Demo company retained for inspection. Existing local records were not migrated or deleted. No Salesforce or HubSpot customer records were changed.

## Improvements in this verification pass

- Inspect the selected candidate provider's schema without saving or changing the active provider.
- Preserve mappings separately when switching providers; synchronize the connection form after provisioning/saving.
- Reject selecting a provider with missing or placeholder configuration on the server.
- Keep command errors and clarification visible beside the input, not just in temporary notifications.
- Explicitly tell the command model when an exact record is already selected. The previously failing selected-record update produced the correct proposal after this change; model responses still require review.
- Owners can see executing/uncertain proposals requiring reconciliation, including those started by another member.

## Automated verification

- Server: 97 passed, one optional integration test skipped.
- Client: 48 passed.
- TypeScript check and production build passed.
- Three added connection regression tests cover provider-specific mappings, candidate schema inspection, and unconfigured-provider rejection.

## Remaining acceptance work

This is not a zero-defect or production-certification claim. Browser microphone capture and recognition quality with the user's English/Malay speech still need hands-on testing. Salesforce/HubSpot writes require dedicated test records and verification. Fine-tuning has not run: reviewed, consented command/speech data and a suitable training environment are still required. The Docker app startup path also needs its own acceptance run; the application tested here is the local server on port 3000.
