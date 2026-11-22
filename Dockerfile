# MEAT / Polymarket — production image
#
# The engine is dependency-free (Node built-ins only), so the image is tiny: just
# copy the source and run. The official Polymarket signing SDK (@polymarket/clob-client)
# is lazily imported ONLY when a live order is submitted; if you want real order entry
# inside the container, uncomment the npm install line below.
#
# Build:   docker build -t meat-polymarket .
# Run:     docker compose up -d        (reads ../.env via docker-compose.yml)

FROM node:22-alpine

# Run as a non-root user (the container only needs to read its own state dir).
RUN addgroup -S meat && adduser -S meat -G meat

WORKDIR /app

# Copy the whole monorepo (packages/automaton-trading is the engine; scripts/ has
# operational helpers). Keep .dockerignore tight so secrets and state never bake in.
COPY --chown=meat:meat packages ./packages
COPY --chown=meat:meat scripts ./scripts
COPY --chown=meat:meat automaton.config.json ./automaton.config.json

# Install the official Polymarket signing SDK. Even read-only account queries
# (getAccount -> balance-allowance) need it for L1/L2 auth, so it is required for a
# funded run, not just for order entry. It is lazily imported: markets/book/prices
# reads work without it, but anything touching the wallet (balance, positions, orders)
# requires the SDK to sign L1 EIP-712 and derive L2 API credentials.
RUN cd packages/automaton-trading && npm init -y >/dev/null 2>&1 && \
    npm install @polymarket/clob-client ethers@5 --no-audit --no-fund 2>&1 | tail -3 && \
    chown -R meat:meat node_modules package.json package-lock.json

# Default state dir. docker-compose mounts a named volume here so deaths, ledger,
# obituaries, and calibration survive container restarts.
ENV AUTOMATON_STATE_DIR=/app/state
# Create the state dir while still root, then hand ownership to the runtime user.
RUN mkdir -p /app/state && chown meat:meat /app/state
VOLUME ["/app/state"]

USER meat

# The engine CLI. Override the command in docker-compose for different modes.
ENTRYPOINT ["node", "packages/automaton-trading/bin/automaton.mjs"]
