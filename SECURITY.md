# Security

## Reporting a vulnerability

Report security issues privately to **security@gledach.de**. Please do not open a public
issue for anything exploitable.

Include what you did, what happened, and what you expected. A proof of concept helps.
Expect an acknowledgement within a few days; this is a small project, not a vendor with
an on-call rotation.

## What this project does with your data

Signal runs entirely on your machine. It has no telemetry, no phone-home, and no hosted
component. The only outbound traffic is to the sources you configure and, if you supply a
key, to your LLM provider.

## Known posture — read before deploying

**The dashboard has no authentication.** `serve.mjs` binds `127.0.0.1` deliberately and
exposes destructive endpoints. Do not bind it to `0.0.0.0` or put it behind a public
tunnel without adding an auth layer first.

**Secrets live in `.env`**, which is gitignored. Nothing in this repo needs a secret to
run — the default database is a local file. Keys are only required for LLM classification
and optional paid sources.

**Generated analysis is model output.** Battlecards and briefs are written by a language
model from public sources. They are not verified fact and must be reviewed by a human
before being used externally or shown to a customer. See the disclaimer in `README.md`.

## Dependencies

The dependency count is kept deliberately small and there is no build step, so the
supply-chain surface is roughly the seven runtime packages in `package.json`. Report
anything you find there upstream as well as here.
