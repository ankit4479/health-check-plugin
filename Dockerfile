# 24/7 interactive bot image for health-check-plugin.
# Build:  docker build -t health-check-bot .
# Run:    docker run --env-file .env -v $PWD/health-check.config.json:/app/health-check.config.json health-check-bot
#
# The bot needs the optional deps (discord.js / @slack/bolt), so this installs all
# dependencies (not --omit=optional). Provide bot tokens via --env-file.

FROM node:20-slim

WORKDIR /app

# Install deps (including optional discord.js / @slack/bolt for the bot).
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# App source.
COPY tsconfig.json ./
COPY src ./src
COPY config ./config

# The config + .env are mounted/provided at run time, not baked into the image.
# Start the interactive bot (posts reports with buttons + self-schedules).
CMD ["npx", "tsx", "src/cli.ts", "bot"]
