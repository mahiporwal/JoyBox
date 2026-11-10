# Joybox

Joybox is a small arcade-site starter with a responsive game catalog, demo mini-game, sign-up/sign-in, and saved favorites.

## Run locally

Requirements: Node.js 20 or newer.

```powershell
npm install
npm start
```

Open <http://127.0.0.1:3000>. Run the backend tests with `npm test`.

Without `DATABASE_URL`, local development stores account records in `data/accounts.json` and keeps sessions in memory. This mode is only for local development and tests. Without Resend credentials, local account emails are printed as development previews in the server terminal; never use this email mode in production.

## Run the production-style stack locally

Requirements: Docker Desktop with Compose.

1. Copy `.env.example` to `.env`.
2. Replace `JOYBOX_DB_PASSWORD` with a long random hexadecimal value. For example:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```
3. Start the app and PostgreSQL:

   ```powershell
   docker compose up --build
   ```

4. Open <http://127.0.0.1:3000>. The PostgreSQL data is kept in the `joybox_db` Docker volume.

To stop the stack, use `docker compose down`. To delete the database too, use `docker compose down --volumes` (this permanently deletes local accounts).

## Deploy to a hosting provider

This project includes a Dockerfile and can be deployed to any provider that supports Docker and managed PostgreSQL. For the selected Render route, create a PostgreSQL instance and a Docker web service from this repository. Configure a health check at `/healthz`, use the same region for app and database, attach a persistent managed database, and configure these app environment variables in the provider dashboard:

1. Create a GitHub repository and push the project source. Do not commit `.env`, account data, provider secrets, or `node_modules`.
2. In Render, create a managed PostgreSQL database and a Docker web service connected to that repository. Use a paid persistent database for real accounts; confirm the selected database's backup and retention terms.
3. Configure the environment variables below in the web service. Use the database's internal connection URL when app and database are in the same Render region.
4. Deploy and wait for the `/healthz` check to pass. Test signup, email delivery, verification, login, reset, logout, and favorites on the Render-provided HTTPS URL using addresses you control.
5. Purchase a domain from a registrar. Add it as a custom domain to the Render web service, then copy the exact DNS records Render provides into the registrar's DNS panel. Wait for verification and TLS certificate provisioning; test both the custom URL and HTTPS redirects before sharing it.
6. Configure `PUBLIC_APP_URL` to the final canonical HTTPS domain, redeploy, and test account links again. Keep one canonical host (with or without `www`) and redirect the alternate.

Do not post domain-account credentials, database URLs, Resend keys, or DNS verification tokens in chat or commit them to the repository.

| Variable | Required | Value |
|---|---|---|
| `NODE_ENV` | Yes | `production` |
| `HOST` | Yes | `0.0.0.0` |
| `PORT` | Usually provided by the host | The host's assigned port |
| `DATABASE_URL` | With accounts enabled | The managed PostgreSQL connection string |
| `DATABASE_SSL` | Provider-dependent | Set to `true` if the provider requires TLS for PostgreSQL |
| `COOKIE_SECURE` | No | Leave unset for secure HTTPS cookies |
| `DB_POOL_SIZE` | No | Defaults to `10`; follow the database provider's connection limits |
| `TRUST_PROXY` | Provider-dependent | Set to `true` only if the ingress proxy overwrites `X-Forwarded-For` and direct app access is blocked |
| `ENABLE_ACCOUNTS` | No | Set to `false` for guest-only launch without email/domain setup; defaults to enabled |
| `PUBLIC_APP_URL` | With accounts enabled | Canonical HTTPS URL, such as `https://your-service.onrender.com` |
| `RESEND_API_KEY` | With accounts enabled | Resend API key stored as a secret |
| `RESEND_FROM_EMAIL` | With accounts enabled | Verified sender, for example `Joybox <accounts@your-domain.example>` |

For a guest-only deployment before you own a domain, set `NODE_ENV=production` and `ENABLE_ACCOUNTS=false`; remove `DATABASE_URL`, `PUBLIC_APP_URL`, `RESEND_API_KEY`, and `RESEND_FROM_EMAIL` if you have not configured them. The games/catalog and public legal pages still work; account sign-in, signup, and favorites are hidden and their API endpoints are disabled. The account feature becomes available only when you switch `ENABLE_ACCOUNTS=true` and supply `DATABASE_URL`, `PUBLIC_APP_URL`, `RESEND_API_KEY`, and `RESEND_FROM_EMAIL`. Production startup validates those settings before accepting accounts.

The database schema is created at startup when configured. The host must provide HTTPS, health checks can use `/healthz`, and database backups should be enabled in the provider. Keep all secrets in the provider's secret/environment-variable manager; never commit them.

Email verification links expire after 24 hours. Password-reset links expire after one hour, are single-use, and invalidate active sessions. Email addresses must be verified before login. Configure and verify the sending domain in Resend before using public sign-up; test delivery and spam handling with your own addresses first. Unknown addresses receive the same password-reset and verification response to reduce account enumeration.

For production, use the app and database in a compatible region, restrict database network access to the app, and configure provider-level request rate limits. The built-in sign-in attempt limiter is per-process and is not a substitute for edge protection. Set `TRUST_PROXY` only when the host prevents clients from directly reaching the app and replaces (rather than blindly appends) the forwarded client-IP header.

## Before a public launch

- Connect a domain, configure DNS, and verify HTTPS and redirects on the chosen host.
- Complete Resend sender-domain verification, SPF/DKIM setup as instructed by Resend, and test email verification and account recovery.
- Replace the demo catalog/minigame and emoji covers with original or properly licensed playable games and artwork. Do not copy Poki's brand or assets.
- Complete every bracketed placeholder in `privacy.html` and `terms.html`, then obtain review for the actual operator, data practices, age group, and jurisdictions. They are draft templates, not legal advice or ready-to-publish legal documents.
- Decide what age groups the site serves and implement any applicable privacy/consent requirements.
- Test signup, login, logout, favorites, database backup/restore, mobile layout, accessibility, and load behavior on the deployed HTTPS site.
- Set up monitoring, error alerts, backups, and a process for patching Node.js and dependencies.

This repository prepares a deployable app and local production-style stack; it does not provision hosting, a domain, email delivery, legal review, original game content, or production secrets.
