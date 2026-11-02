# HubSpot login, Salesforce objects and voice

## HubSpot

HubSpot workspace now has Sign in, Switch account and Disconnect. OAuth connects
the HubSpot account chosen on HubSpot's own authorization page to the signed-in
local CRM user. Passwords are never collected by LocalVoice. Each user has an
isolated connection. The app must be allowed to install in that account and its
requested scopes must be supported by the account's subscription.

Set these on the server (for the private Docker setup, `.env.staging`):

```dotenv
HUBSPOT_CLIENT_ID=
HUBSPOT_CLIENT_SECRET=
HUBSPOT_OAUTH_SCOPES=oauth crm.objects.contacts.read crm.objects.contacts.write
HUBSPOT_OAUTH_OPTIONAL_SCOPES=
HUBSPOT_TOKEN_ENCRYPTION_KEY=
```

Create a HubSpot OAuth app and register this exact redirect URL:
`https://localhost:3100/api/hubspot/callback`. Copy its client ID and secret into
the server environment, not into chat or frontend code. Match the configured
required/optional scopes to the app's settings. Add the corresponding CRM object
and schema scopes for companies, deals, tickets and other records you need.
Do not request every available scope blindly: accounts may not support them.

The encryption key is a base64-encoded 32-byte key. If omitted, the existing
SALESFORCE_TOKEN_ENCRYPTION_KEY is used. Without either key, connections only
survive for the running process. Docker persists encrypted HubSpot connection
files in its own token volume. Recreate the app container after changing env.

The existing HUBSPOT_ACCESS_TOKEN remains an administrator-only shared connection;
it cannot log in to arbitrary accounts. Disconnect stores an explicit disabled
state so it never silently falls back to this token. To revoke authorization
at HubSpot too, uninstall the integration in HubSpot Connected Apps. Switching
accounts invalidates existing voice sessions and pending HubSpot reviews.

Legacy import/sync uses the original administrator connection only. It is blocked
while an OAuth account is selected, because imported IDs are not account-namespaced.
OAuth records are managed live in the HubSpot workspace instead.

## Salesforce

Salesforce opens with Accounts, Contacts, Opportunities (deals), Tasks, Leads,
Cases, Events and Campaigns. Additional accessible/custom objects are available
in the object selector. Fields, picklists and allowed actions come from the
connected organization's metadata; this is not a clone of Salesforce Lightning
page layouts. Read/Create/Edit/Delete all use live APIs. Deletes require DELETE
on the server, not just a client-side button. Cancel revokes the prepared review.

## Voice

Voice → Open live call → choose HubSpot or Salesforce → Start call.
Examples: “List accounts”, “Read contacts Maya Chen”, “Create account, name Acme”,
“Update contact Maya Chen, phone 5551234”. Salesforce deals use Opportunity.
Multiple matches require choosing a specific record. Changes are prepared, read
aloud and held until “confirm change”; deletion requires “confirm delete”.
Interrupting readback does not authorize a write. Say “cancel change” to discard.
Local dictation remains separate. Custom objects can be managed with the record
workspace; voice currently routes common standard object names.

OAuth requires a real browser authorization test after credentials are configured.
Mocked tests do not establish that HubSpot approved the app or its scopes.

Reference: [HubSpot OAuth](https://developers.hubspot.com/docs/api-reference/legacy/authentication/manage-oauth-tokens).
