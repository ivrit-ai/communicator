# Communicator

Messages from the services you use, as push notifications on your devices. Live at
https://communicator.ivrit.ai. Its first source is
[Eliezer](https://github.com/ivrit-ai/eliezer), ivrit.ai's transcription bot: a user links
their WhatsApp number once, and Eliezer's transcripts arrive here instead of in WhatsApp.

(The code calls itself `notifier` in places: that was its name before Communicator.)

## How it works

- **Accounts.** Sign in with Google (through the xhostd platform), or continue without an
  account; signing in with Google later adopts everything the anonymous account had.
- **Sources.** A service is registered by an admin (the Admin tab, for emails in
  `ADMIN_EMAILS`) and authenticates with its own key. A user links a source by taking a
  10-character code from the app to the source (for Eliezer: a prefilled WhatsApp message);
  the source redeems it for a subscription id and sends messages to that id. See
  `src/routes/source-api.js` for the API.
- **Personal tokens.** "Scripts & API" tokens let your own scripts send you notifications
  with a single `POST /api/notify`.
- **Delivery.** Web Push (VAPID) to every registered device, from a separate sender process
  with retries. The server keeps messages for three days; each device keeps its own copy
  (IndexedDB), and the full text of a long message is fetched with the delivery ack.
- **UI.** Vanilla JS, no build step, in `public/`: Hebrew and English, light and dark.

## Running locally

Needs Node 18+ and Postgres.

```bash
npm ci
XHOST_HTTP_PORT=3000 \
DATABASE_URL=postgresql://postgres:dev@127.0.0.1:5432/notifier \
VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com \
ACK_SECRET=any-long-random-string \
EXPECTED_HOSTS=localhost \
ADMIN_EMAILS=you@example.com \
node server.js
```

Generate VAPID keys with `npx web-push generate-vapid-keys`. Optional:
`NOTIFY_RATE_PER_MINUTE` (per personal token, default 120) and `SENDER_CONCURRENCY`
(default 32).

## Tests

```bash
npm test
```

Starts a throwaway Postgres in Docker (or uses `TEST_DATABASE_URL`), the real server, and a
local HTTPS push service that decrypts what the sender delivers.

## Deploying

Runs on xhostd as the app `notifier` (channel `prod`, deployed from `master`). Push `master`
to `git@git.xhostd.com:bender/notifier.git`, then deploy that commit to `prod`. Icons are
rendered from `assets/` with `scripts/build-icons.sh`.
