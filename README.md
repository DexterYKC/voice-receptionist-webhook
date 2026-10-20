# Voice Receptionist Webhook — AI phone agent alerts for small businesses

A small, production-minded backend for an **AI voice receptionist**: when a business can't pick up the phone, a [Retell](https://www.retellai.com) voice agent takes the call, collects the caller's request, and this webhook turns the post-call analysis into an **instant Telegram message for the owner** ("who, what, when, call back"). It is the serverless piece I used behind real voice-agent demos.

This is a sanitized export: no client names, keys or numbers (phone numbers in tests are fictional).

## How it works

```
Caller ─► Retell voice agent ─► post-call extraction (9 structured fields)
                                         │  call_analyzed webhook (signed)
                                         ▼
                          api/retell-webhook.ts  (Vercel function)
                                         │  verify signature → build message
                                         ▼
                                  Telegram message to the owner
```

## What's in the repo

- **`api/retell-webhook.ts`** — the webhook handler
  - Verifies Retell's **signature over the raw body** and rejects anything else with 401
  - Handles only the `call_analyzed` event and ignores the rest with a 200
  - Defensive parsing: Retell can return booleans as strings, fields can be missing, the extraction can be empty
  - **Never sends an empty or emoji-only message**: falls back to Retell's call summary, then to an explicit "call ended without an actionable request"
  - Priority callbacks get a 🔴 marker; demo calls are tagged with a label taken from call metadata, validated against a strict pattern so metadata can't inject content
  - Telegram call has a **3 s timeout** (Retell waits about 5 s), messages are truncated to Telegram's 4096-character limit, and a Telegram failure still returns 200 so Retell doesn't retry and duplicate alerts
- **`scripts/test-webhook.ts`** — a local harness that builds **correctly signed** webhook payloads and runs scenarios through the real handler (standard request, priority callback, empty extraction, empty extraction with summary, unknown/invalid metadata), with Telegram mocked. `--live` sends to real Telegram, `--url` targets a running `vercel dev`.
- **`niches/`** — the **agent prompts and extraction schema** for demo agents (generic services company; dental clinic, real estate agency and law firm in English). They show the prompt-design rules I rely on: never confirm a booking or price, one question at a time, read phone numbers back digit by digit, escalate urgencies, always offer a human callback.

## The nine extraction fields

Every agent, whatever the industry, returns the same fields (`type_demande`, `nom`, `telephone`, `produit`, `mode`, `adresse`, `date_souhaitee`, `rappel_prioritaire`, `sms_patron`), so **one webhook serves all agents**. Only the prompt and the field descriptions change per industry; `sms_patron` is a ready-to-read one-or-two-sentence brief for the manager.

## Run it

```bash
npm install
npm run typecheck
npm run test:local          # signed payloads, Telegram mocked
```

Deploy `api/retell-webhook.ts` as a Vercel function and set `RETELL_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (see `.env.example`).

## Stack

TypeScript · Vercel serverless functions · Retell SDK (webhook signature) · Telegram Bot API.

## Scope

A backend and a prompt library, not a full product: no UI, no database. Prompts are written in French (Belgian conventions) or English.
