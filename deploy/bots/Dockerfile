# Build on Linux x64. Native engines are compiled separately for each bot.
FROM node:24-bookworm-slim AS node
FROM rust:1.96-slim-bookworm AS rust
FROM python:3.12.16-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV PATH="/usr/local/cargo/bin:${PATH}" CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup CARGO_BUILD_JOBS=1
RUN apt-get update && apt-get install -y --no-install-recommends git build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
WORKDIR /opt/showdown
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit
COPY app ./app
COPY scripts ./scripts
COPY vendor/laplace ./vendor/laplace
RUN node scripts/bots/setup.cjs --build-linux --python python3
RUN useradd --uid 10001 --create-home battle && chown -R battle:battle /opt/showdown
USER battle
ENV BOT_SERVICE_HOST=0.0.0.0 PORT=8787 BOT_MAX_SESSIONS=1
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/healthz',{headers:{host:new URL(process.env.BOT_SERVICE_ORIGIN).host}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/bots/service.cjs"]
