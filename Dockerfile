# syntax=docker/dockerfile:1

FROM node:26.12.0-trixie-slim AS build
ARG TARGETARCH
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Pyroscope for the platform being built, checked against the checksum pinned in the script (ADR 0027, 0068).
RUN node scripts/pyroscope.ts linux "${TARGETARCH:-amd64}" /app/vendor \
  && npm run build && npm prune --omit=dev && mkdir -p /out/data

# Node runs the TypeScript sources directly; only production dependencies are copied. Pyroscope is one static binary,
# so the image needs nothing else (ADR 0068).
FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /app
COPY --from=build /app/package.json /app/openapi.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/vendor/pyroscope ./vendor/pyroscope
COPY --from=build /app/dist/web ./dist/web
COPY --from=build /app/dist/docs ./dist/docs
COPY --from=build --chown=nonroot:nonroot /out/data /data
# SQLite and Pyroscope's storage live in /data, so the root filesystem can be read-only (ADR 0022).
ENV NODE_ENV=production PORT=8080 PROFILING_DATA=/data
VOLUME /data
EXPOSE 8080
USER nonroot
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["server/main.ts"]
