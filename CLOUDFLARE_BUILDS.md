# Cloudflare Builds Checklist

This project deploys in source-first mode.

- Worker name: `ni-mail`
- Wrangler entrypoint: `src/index.ts`
- Compatibility passthrough: `worker.js`
- Deploy command: `npm run deploy`
- Build command: leave empty
- Root directory: repository root (`/` or blank)

If you upload files manually to GitHub, include the entire `src/` folder. The deployment will fail if `wrangler.jsonc` is present but `src/index.ts` is missing from the repository snapshot.

## Required dashboard settings

In Cloudflare Dashboard for Worker `ni-mail`:

1. Open `Settings -> Builds`.
2. Confirm the connected GitHub repository is this project.
3. Confirm the production branch is the branch that already contains `src/index.ts` and the current `wrangler.jsonc`.
4. Set `Root directory` to `/` or leave it blank.
5. Leave `Build command` empty.
6. Set `Deploy command` to `npm run deploy`.
7. Save the settings.
8. Retry the failed build.

## Local verification

Run these commands from the repository root:

```bash
npm clean-install --progress=false
npm run check:deploy
```

Expected result:

- Wrangler resolves `src/index.ts`
- Wrangler detects the `MAILBOX` Durable Object binding
- Wrangler detects the `BUCKET` R2 binding

After a local `npm run dev` or a production deploy, run:

```bash
BASE_URL=https://<your-worker-or-domain> AUTH_KEY=<your-key> MAILBOX=hello@example.com npm run smoke
```

Mailbox reads may return `404` until mail arrives.

## If Git Builds still says `src/index.ts` is missing

Treat that as a stale or misbound Cloudflare Builds source configuration.

1. Disconnect the GitHub repository from Worker `ni-mail`.
2. Reconnect the same repository.
3. Re-select the correct production branch.
4. Re-apply the settings above.
5. Trigger a fresh build with a new commit or a manual retry.

## Smoke test after deploy

```bash
curl https://<your-worker>/health
```

Expected response:

```json
{ "ok": true, "service": "ni-mail" }
```
