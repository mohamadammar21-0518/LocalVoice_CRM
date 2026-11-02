# CI release gates

`.github/workflows/release-gates.yml` runs on pull requests, pushes to `main` and `codex/**`, version tags, and manual dispatch. Both jobs must pass before merging or publishing a release. Configure branch protection to require `verify` and `security` if this repository is hosted on GitHub.

The verify job installs with the frozen lockfile, runs TypeScript and both test suites, builds the production bundle, applies and previews migrations against an isolated MySQL service, then starts the built API and checks login, an authenticated CRM read, and rejection of an anonymous read. It also audits production dependencies and validates all Compose files with temporary CI values.

The security job scans the checked-out repository for secrets and builds and scans the production container for fixable high and critical vulnerabilities. It never uses local CRM credentials or customer data.

Run the checks locally with `corepack pnpm check`, `corepack pnpm test`, `corepack pnpm test:client`, `corepack pnpm build`, and `corepack pnpm audit --prod --audit-level low`. The migration and API smoke checks require a disposable MySQL database and the CI environment variables defined in the workflow.
