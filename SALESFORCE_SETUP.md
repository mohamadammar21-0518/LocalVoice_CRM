# Salesforce connection and record actions

Goal: Connect a Salesforce Developer Edition organisation, find a fictional contact and its open tasks, then use the record workspace to read, create, edit and delete permitted records with explicit review.

## 1. Create your learning organisation

Open https://developer.salesforce.com/signup and complete signup and email verification. Your Salesforce username must be globally unique and normally looks like an email address; it may differ from your contact email. Set your password directly with Salesforce. Never paste passwords or client secrets into a chat or public repository.

Log in, choose the Sales application from the App Launcher, and locate Accounts, Contacts and Tasks. Your default developer app may have a different navigation layout; search the App Launcher if a tab is absent.

Developer Edition is for development/testing, not your customer's production deployment.

## 2. Create a fictional contact and tasks manually

1. Accounts > New: Account Name = Acme Demo. Save.
2. Contacts > New: First Name = Maya, Last Name = Chen, Account Name = Acme Demo. Optional email = maya@example.com. Save.
3. On Maya's activity area select New Task, or open Tasks > New Task.
4. Create a task with Subject = Send demonstration agenda, an upcoming Due Date, and an open Status such as Not Started. Set the Name field to Maya Chen. The Related To field can be Acme Demo, but Name must point to Maya for this milestone's query. Save.
5. Create another open task: Arrange product demonstration. Set Name to Maya Chen. Save.
6. Optional: create a completed task named Previous introduction call. It should not appear in the open-task results.

Success checkpoint: You can find Maya and see the two open tasks manually inside Salesforce.

## 3. Register this application's OAuth integration

In Salesforce Setup, search for External Client Apps. Use External Client App Manager to create a new local External Client App. Exact section labels can vary with your organisation's release and settings.

- App name: LocalVoice CRM Learning.
- Supply your contact email.
- Enable OAuth settings.
- Callback URL for the private Docker staging app: `https://localhost:3100/api/salesforce/callback`. For another deployment, use the exact HTTPS callback displayed by the Salesforce tab; Salesforce does not accept a plain-HTTP external-client callback.
- OAuth scopes: Manage user data via APIs (api); Perform requests at any time (refresh_token/offline_access).
- Enable the OAuth web server/authorization-code flow. Where the UI groups flows under Authorization Code and Credentials Flow, enable the setting that permits authorization-code login; this project does not use the username/password grant.
- Require PKCE for supported authorization flows. The connector sends an S256 challenge and verifier.
- Allow your learning user to authorize the app. If the policy requires admin pre-approval, assign the app to an appropriate permission set for that user.
- Keep the client-secret requirement enabled for the web server flow and refresh-token exchange when those settings are available; configure the secret on the backend.

Save and obtain the Consumer Key (client ID) and Consumer Secret. Those values belong only in your local server configuration. The app never requests your Salesforce password.

Use Setup > My Domain to obtain the organisation's login origin, for example https://your-org.develop.my.salesforce.com. Use the exact domain shown, without extra paths. The connector binds both authorization and API calls to that organisation.

Current Salesforce authorization documentation: https://developer.salesforce.com/docs/platform/api-rest/guide/intro-oauth-and-connected-apps.html
External Client App OAuth settings: https://help.salesforce.com/s/articleView?id=xcloud.configure_external_client_app_oauth_settings.htm&language=en_US&type=5

## 4. Configure the existing CRM

Add these entries to your existing .env; preserve your database, login and speech settings:

    SALESFORCE_LOGIN_URL=https://YOUR-ORG.develop.my.salesforce.com
    SALESFORCE_CLIENT_ID=YOUR_CONSUMER_KEY
    SALESFORCE_CLIENT_SECRET=YOUR_CONSUMER_SECRET
    SALESFORCE_API_VERSION=64.0

The default API version is 64.0; use an available version if your organisation reports it unsupported. Your Salesforce user needs API access and the relevant object, field and record permissions. User record-sharing rules are enforced by Salesforce.

Restart the CRM server after changing .env. For development: pnpm dev. For the compiled app: pnpm build, then pnpm start. Do not run both servers on port 3000 simultaneously.

## 5. Connect and run the typed request

1. Open the exact configured CRM origin—`https://localhost:3100` for private Docker staging—and sign in with your local CRM account.
2. Select Salesforce in the sidebar.
3. Select Connect my Salesforce account.
4. Sign in on the Salesforce page and approve the requested access.
5. You return to the Salesforce lookup screen in the CRM.
6. Enter Find Maya Chen and select Find contact.
7. Select Maya Chen at Acme Demo.
8. Confirm that the two open tasks appear and the completed task does not.
9. Change a task to completed manually in Salesforce, then select Refresh tasks in the CRM. It should disappear.

Duplicate contact names are shown as separate choices with company/email. Search shows at most 20 matches; refine the name if truncated. Open tasks show at most 100 records directly linked through Task.WhoId. Tasks related only to an account/opportunity, grouped-task edge cases or additional activity associations are outside this first milestone.

The contact lookup supports a contact name or a request beginning Find, Look up, Search for or Cari. The Voice tab supports requests such as "Find Maya Chen and read her open tasks" and "Cari Maya Chen dan baca tugasan". It reads the first five tasks aloud and displays all retrieved tasks (up to 100).

## Read and change other Salesforce records

Open the **Salesforce records** workspace on the Salesforce or Voice tab. It discovers the objects and fields available to the connected user through Salesforce metadata. Choose an object and Read, Create, Edit or Delete. Browse the first 50 records or search by a filterable name field, select an exact record for Edit/Delete, and review every proposed change before confirming. Delete also requires typing `DELETE`. The server validates object and field permissions from the current Salesforce metadata and holds the reviewed operation in a short-lived, owner-bound token. Salesforce makes the final permission decision.

For voice, select the Salesforce workflow and dictate a structured command such as `Create Account, Name = Acme Demo, Phone = 5551234`. The transcript chooses the object and action and can fill fields written as `Field = value` pairs separated by commas. Review the selected object, fields and record on screen. You can correct recognition errors before confirming. The app never runs a write merely because transcription finished. A spoken success receipt follows a confirmed write when speech playback is enabled. This is a fast rule-based command path; it does not use a model to guess arbitrary field mappings.

The generic editor supports Salesforce scalar fields, picklists and record-ID references. Compound addresses, binary fields, relationships that require nested payloads, bulk operations and Salesforce administrative setup changes need dedicated workflows. Some objects can be listed but lack a searchable name field; browse by ID in that case. Creation still needs Salesforce-required fields, which vary by object and organisation. A Salesforce API or permission error is shown if a requested operation is unavailable.

## Connection behaviour and troubleshooting

Each local CRM user connects their own Salesforce account. A local administrator role is not required, and no local roles are changed. HubSpot remains available independently.

OAuth uses a browser-bound random state, PKCE, owner/session checks and server-only tokens. With SALESFORCE_TOKEN_ENCRYPTION_KEY configured, access and refresh tokens are saved using AES-256-GCM in .localvoice-private/salesforce. Encrypted records are bound to the local user, Salesforce organisation and OAuth client. Server restarts preserve these connections. Without the key, tokens remain memory-only. Logout, password reset and session revocation invalidate the saved connection; reconnect after these actions. Never use browser storage for Salesforce tokens. This store supports one Node process only.

- Configuration not ready: check the server .env entries and restart.
- Callback mismatch: compare the configured URL character-for-character. `localhost` and `127.0.0.1` are different browser cookie origins; use `https://localhost:3100` throughout the local Docker login/connect flow. Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-local-https.ps1` if the local certificate must be regenerated.
- App access denied: check app authorization policy, assigned permissions and API access.
- No contact: ensure the record exists in the connected organisation and is visible to that user.
- No tasks: set the task's Name to the contact and ensure its status is open. Related To alone is not sufficient.
- Connection failure: check client ID/secret, permitted OAuth flow, scopes and PKCE settings, then reconnect. The app hides provider error bodies to avoid exposing credentials or customer information.
- Disconnect removes the local connection and attempts to revoke its Salesforce authorization. If remote revocation fails, remove the authorization in Salesforce's connected/external-app OAuth management page.

Save a short demo showing manual Salesforce records, typed contact lookup and the open-task result. Document the exact permissions and data mapping you used. This is your first integration portfolio checkpoint.

## Encrypted connection setup and recovery

Generate a base64 32-byte key once and save it as SALESFORCE_TOKEN_ENCRYPTION_KEY in the server secret configuration. Do not reuse JWT_SECRET. The local workspace may already have this setting; preserve an existing key. Restart the server and connect once to create the encrypted record. The Salesforce panel shows whether the connection is saved with encryption.

Keep the key private and stable across ordinary restarts. Treat changing the key, OAuth client or organisation as a new connection: clear the old saved connection in the Salesforce panel and reconnect. Tampered files or missing/wrong keys fail closed. The disconnect action removes the local file and attempts provider revocation; if the token cannot be recovered or revocation fails, remove the authorization in Salesforce.

The existing database/audio backup intentionally excludes OAuth token files. After a recovery on a new host, generate a new key and reconnect Salesforce. If migrating existing connections is required, securely transfer both the encrypted directory and its key separately. Multiple replicas require shared credential storage and distributed refresh locking before deployment.
