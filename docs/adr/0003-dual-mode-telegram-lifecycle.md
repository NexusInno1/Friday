# 3. Dual-Mode Telegram Lifecycle (Long Polling & Webhooks)

We decided to support dual execution modes in the entrypoint: Long Polling for local development and Webhook mode for cloud deployment when `WEBHOOK_URL` is configured.

## Context
Local development with webhooks requires ngrok or public SSL tunnels, which creates friction. In production on cloud container environments (Railway), webhooks reduce idle connection overhead and integrate with HTTP load balancers.

## Decision
If `WEBHOOK_URL` environment variable is defined, the bot mounts the grammY webhook handler on Express and registers the webhook URL with Telegram API. If `WEBHOOK_URL` is empty, it starts native long polling (`bot.start()`). Both modes share the same health check HTTP server on `HEALTH_PORT`.

## Consequences
- Developers can run `npm run dev` out of the box with zero tunneling tools required.
- Production deployments can switch to webhooks simply by setting the `WEBHOOK_URL` environment variable on Railway.
