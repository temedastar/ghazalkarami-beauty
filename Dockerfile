# Repo root is a monorepo: the real Node app lives in backend/, and it
# serves public/ and admin-panel/ as static files by walking up from its own
# dist/ folder (see backend/src/server.ts, backend/src/lib/renderIndex.ts).
# Liara's buildpack auto-detection scans the repo root for a package.json,
# finds none there, and has nothing to build — this Dockerfile makes the
# build explicit instead of relying on that detection.
FROM node:20-alpine AS build
# node:20-alpine has no OpenSSL package installed — Prisma's schema/query
# engine binaries link against libssl and fail to even start without it
# ("Could not parse schema engine response" is that failure's stdout, a
# plain-text error, getting fed to a JSON parser). Needed in this stage
# because `prisma generate` probes the installed OpenSSL version to pick
# the matching engine build.
RUN apk add --no-cache openssl
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine
# same requirement as the build stage, but now for the engine binaries
# actually running at container start (migrate deploy / db seed / the app)
RUN apk add --no-cache openssl
WORKDIR /app/backend
ENV NODE_ENV=production
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/prisma ./prisma
COPY --from=build /app/backend/package.json ./package.json
COPY --from=build /app/backend/ecosystem.config.js ./ecosystem.config.js
COPY public /app/public
COPY admin-panel /app/admin-panel

# fallback default — Liara's Node/Docker platform injects its own PORT at
# runtime, which src/lib/env.ts already reads via process.env.PORT
ENV PORT=3000
EXPOSE 3000

# migrate deploy is non-interactive and safe to re-run on every deploy (it's
# a no-op if the DB is already at the latest migration) — this is what
# actually creates the tables on the real Liara Postgres instance, since
# nothing outside Liara's own network can reach it (see earlier session:
# raw-TCP database connections aren't reachable from the dev/test sandbox).
# `migrate deploy` does NOT run the seed script (that's Prisma's documented
# behavior — auto-seeding only happens on `migrate dev`/`migrate reset`), so
# without an explicit `db seed` here the tables would exist but stay empty:
# no admin login, no bookable time slots, no default categories/prices.
# seed.ts is upsert-only throughout, so re-running it on every deploy is safe.
CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma db seed && npm start"]
