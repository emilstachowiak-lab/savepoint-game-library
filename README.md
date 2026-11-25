# Savepoint 2.0

Savepoint is a single-account game library with Polish and English interfaces, 22 themes, and optional animated backgrounds. Track platforms, editions, play status, and covers. Browse, filter, and sort the library or import and export it as JSON. Optional Gemini features identify games from photos, suggest covers, and flag duplicate entries for review.

Cloudflare Pages serves the frontend from `public/`. Pages Functions run the API on Cloudflare Workers. D1 stores games and sessions, R2 stores private cover copies, and Turnstile protects sign-in. The frontend requires no build step.

## Deploy to Cloudflare Pages

Use a Cloudflare account with D1 and R2 enabled. For the command-line steps, install Node.js 22 or later and npm, then open a terminal in the GitHub repository root. Workers Paid is recommended for large imports and photo recognition because these workflows can use more CPU time or subrequests than the Free plan allows. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

### 1. Connect the GitHub repository

1. In the Cloudflare dashboard, open **Workers & Pages → Create application → Pages → Connect to Git**.
2. Authorize Cloudflare to access the GitHub repository and select `savepoint-game-library`.
3. Set the following values and select **Save and Deploy**.

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Framework preset | None |
| Build command | Leave blank |
| Build output directory | `public` |
| Root directory | Leave blank to use the repository root |

Cloudflare builds the Pages Functions from the root-level `functions/` directory. The application can accept sign-ins after you complete the storage and Turnstile setup below. [Cloudflare Pages Git integration guide](https://developers.cloudflare.com/pages/get-started/git-integration/)

### 2. Create and connect D1 and R2

Create one D1 database and one private R2 bucket. These example names can be customized.

```bash
npx wrangler@4 login
npx wrangler@4 d1 create savepoint-db
npx wrangler@4 r2 bucket create savepoint-covers
```

Copy the configuration template to a local file.

```bash
cp wrangler.cleanup.jsonc wrangler.cleanup.local.jsonc
```

In the local file, set `database_name` and `database_id` to the database created above. Then initialize the database.

```bash
npx wrangler@4 d1 migrations apply DB --remote --config wrangler.cleanup.local.jsonc
```

In your Pages project, set the **Production** Functions compatibility date to `2025-11-25` or newer. Open **Settings → Bindings** for **Production** and add both bindings. Keep public access disabled on the R2 bucket. [Pages Functions bindings](https://developers.cloudflare.com/pages/functions/bindings/)

| Binding name | Type | Resource |
| --- | --- | --- |
| `DB` | D1 database | The database created above |
| `COVERS` | R2 bucket | The private bucket created above |

### 3. Configure sign-in

1. Choose your production hostname. Use the project's `pages.dev` address or attach your own hostname under **Custom domains**.
2. Create a Cloudflare Turnstile widget and authorize that hostname in the widget settings. Use production Turnstile keys. [Turnstile setup](https://developers.cloudflare.com/turnstile/get-started/)
3. Run `node scripts/password.mjs` and enter the password you want to use. The script prints the salt and hash for the application.
4. Under your Pages project's **Settings → Variables and Secrets**, add the following to **Production**. Use the Secret type where indicated.

| Name | Type | Value |
| --- | --- | --- |
| `APP_USERNAME` | Secret | Your chosen Savepoint username |
| `APP_PASSWORD_SALT` | Secret | Salt printed by the password script |
| `APP_PASSWORD_HASH` | Secret | Hash printed by the password script |
| `TURNSTILE_SITE_KEY` | Text | Public site key for your Turnstile widget |
| `TURNSTILE_SECRET_KEY` | Secret | Private secret key for the same widget |
| `APP_ORIGIN` | Text | Optional production origin, such as `https://savepoint.example.com`, with no trailing slash. Set it to restrict the API to a single origin. |

### 4. Enable AI and email notifications

Add these Production variables and secrets for the features you want to enable.

| Feature | Configuration |
| --- | --- |
| Gemini photo recognition, cover selection, and duplicate detection | Set `AI_ENABLED` to `true` and store `GEMINI_API_KEY` as a secret. Optional text settings are `GEMINI_MODEL` (default `gemini-3.5-flash-lite`) and `AI_HOURLY_LIMIT` (default `20`). |
| IGDB cover search | Set `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` as secrets from your Twitch application. |
| SteamGridDB cover search | Set `STEAMGRIDDB_API_KEY` as a secret. Wikipedia cover suggestions use a public API. |

Login notifications require `MAIL_FROM` and `MAIL_TO`. Save either address as a secret if it should be hidden in the dashboard. Choose a sending method.

- **SMTP mailbox.** Set `SMTP_HOST` to your provider's SMTP hostname and save the mailbox password as the `SMTP_PASSWORD` secret. Savepoint connects with implicit TLS on port 465 and uses `MAIL_FROM` as the SMTP username. You can keep the site's `pages.dev` hostname.
- **Cloudflare Email Service.** Leave `SMTP_HOST` unset. Set `CF_EMAIL_ACCOUNT_ID` as text and `CF_EMAIL_TOKEN` as a secret. Use an API token with permission to send email, a domain onboarded for sending, and a verified recipient on Workers Free. [Cloudflare Email Service setup](https://developers.cloudflare.com/email-service/get-started/send-emails/)

### 5. Redeploy and verify

1. In the Pages project's **Deployments** tab, redeploy the production commit so the Functions receive the bindings and variables. Future commits to `main` deploy through the GitHub integration.
2. Deploy the scheduled cleanup Worker from the same local configuration. It removes expired uploads, sessions, and rate-limit records every 15 minutes and has no public URL.

   ```bash
   npx wrangler@4 deploy --config wrangler.cleanup.local.jsonc
   ```

3. Open your production HTTPS URL and sign in. Save a test game, refresh the page, and sign out. Check photo recognition, cover search, duplicate detection, and email delivery if you configured those integrations.

If you enable preview deployments, configure preview credentials and storage separately.

## Run locally

Copy the example variables and generate credentials. Put the username, salt, and hash in `.dev.vars` before starting Pages. The example includes Cloudflare's local test keys, which require internet access to Turnstile.

```bash
install -m 600 .dev.vars.example .dev.vars
node scripts/password.mjs
npx wrangler@4 d1 migrations apply DB --local --config wrangler.cleanup.jsonc
npx wrangler@4 pages dev public --port 8788 --compatibility-date 2025-11-25 --d1 DB=00000000-0000-0000-0000-000000000000 --r2 COVERS=savepoint-covers
```

For the local smoke test, use an empty local database and leave `AI_ENABLED=false`. Set `SAVEPOINT_TEST_USERNAME` and `SAVEPOINT_TEST_PASSWORD` in your shell to the local account credentials, then run `node tests/wrangler-smoke.mjs http://127.0.0.1:8788`.
