# Wiom Realtime token-broker — Cloudflare Worker

This Worker mints short-lived OpenAI Realtime client secrets so the browser
prototype can talk to the model without ever seeing your `OPENAI_API_KEY`.

## Deploy in 5 minutes

```bash
# 1. Install wrangler if you don't have it
npm i -g wrangler

# 2. From this folder, log into Cloudflare
cd v5/worker
wrangler login

# 3. Add your OpenAI API key as a worker secret (never committed)
wrangler secret put OPENAI_API_KEY
#    paste your sk-... key when prompted

# 4. (Optional) lock it to your GitHub Pages origin
wrangler secret put ALLOWED_ORIGINS
#    paste:  https://abhishekgarg-wiom.github.io

# 5. Ship it
wrangler deploy
```

Wrangler prints a URL like `https://wiom-realtime-token.<you>.workers.dev`.
Copy that and paste it into `v5/index.html` — see `WIOM_TOKEN_URL` near the
top of the `<script>` block.

## Endpoints

- `POST /token` — body `{ variant: "D1"|"D2", address: string, landmark?: string }`. Returns the OpenAI session payload incl. `client_secret.value`.
- `GET /health` — sanity ping.

## Costs

OpenAI Realtime API is billed per minute of audio (input + output). At time of
writing it's roughly **$0.06/min input + $0.24/min output**. A typical Wiom
verification call is 60-90 seconds, so ~$0.30 per call. Cloudflare Workers
free tier covers 100k requests/day — far above any prototype usage.

## Security notes

- The OpenAI key lives only in the Worker — never in the browser bundle, never in git.
- The minted client secret expires in ~60 seconds and is single-use.
- Set `ALLOWED_ORIGINS` to your GitHub Pages origin before sharing the URL widely.
