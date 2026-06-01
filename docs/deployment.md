# Deployment — running autonomously

Once set up, the health check runs on its own. There are **two autonomy models** —
pick one (or run both):

| Model | What runs it | Hosting | Approvals happen in |
|-------|-------------|---------|---------------------|
| **A. Scheduled CLI + webhooks** | cron / GitHub Actions | none (or GitHub's runners) | your agent (Claude/Codex/Gemini) or `--approve` |
| **B. 24/7 interactive bot** | a long-running `health-check bot` process | an always-on host | buttons inside Discord / Slack |

---

## Model A — Scheduled runs (no server to host)

Generate the schedule:

```bash
# local machine / VPS crontab line + a GitHub Actions workflow
health-check schedule --at "09:00" --tz "Asia/Kolkata" --mode both
```

- **cron**: paste the printed line into `crontab -e`.
- **GitHub Actions**: it writes `.github/workflows/health-check.yml` (cron in UTC).
  Commit it and add the secrets it references in **repo → Settings → Secrets**
  (`DATABASE_URL`, `HEALTH_DISCORD_WEBHOOK_URL`, `HEALTH_SLACK_WEBHOOK_URL`,
  `GITHUB_TOKEN`). GitHub runs it for you — nothing to keep on.

Each run posts a report to your channels (webhooks). You file issues / heal via the
agent skills or the CLI (`health-check issues`, `health-check heal-issue`).

---

## Model B — The 24/7 interactive bot (buttons in-channel)

The bot is a persistent process. It **must be hosted somewhere that stays on.** It
posts reports *with buttons*, self-runs on `bot.runAt`, and runs the approve → file →
fix loop from clicks in the channel.

### 1. Create the bot credentials

- **Discord:** create an application → Bot → copy the **bot token**; invite the bot to
  your server with *Send Messages* + *Read Message History*; copy the **channel id**.
- **Slack:** create an app → enable **Socket Mode** → add a bot token (`xoxb-…`, scope
  `chat:write`) and an app-level token (`xapp-…`, scope `connections:write`); invite the
  bot to the channel; copy the **channel id**.

Put the tokens in `.env` (see `.env.example`) and the channel ids + `bot.enabled: true`
in `health-check.config.json`.

### 2. Run it

```bash
npm install            # installs discord.js / @slack/bolt (optional deps)
health-check bot       # connects, self-schedules, listens for buttons
# add --run-now to post a report immediately on startup
```

### 3. Keep it on (choose a host)

**Docker (anywhere):**
```bash
docker build -t health-check-bot .
docker run -d --restart unless-stopped \
  --env-file .env \
  -v "$PWD/health-check.config.json:/app/health-check.config.json" \
  health-check-bot
```

**systemd (a VPS):**
```ini
# /etc/systemd/system/health-check-bot.service
[Service]
WorkingDirectory=/opt/health-check-plugin
ExecStart=/usr/bin/npx tsx src/cli.ts bot
EnvironmentFile=/opt/health-check-plugin/.env
Restart=always
[Install]
WantedBy=multi-user.target
```

**Railway / Render / Fly.io:** deploy the repo with the start command
`npx tsx src/cli.ts bot`, set the env vars in the dashboard, and mount or commit your
`health-check.config.json`. Socket Mode means Slack needs **no public URL**.

---

## Which should I use?

- Just want **notifications + scored reports** on a schedule, approving in your AI
  agent? → **Model A.** Nothing to host.
- Want a team to **click "Fix" in Discord/Slack** without touching a terminal? →
  **Model B.** You host one small always-on process.
- Want both? Run Model A for the schedule and Model B for interactivity — they share
  the same config and state.
