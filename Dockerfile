# Repo root is a monorepo: the real Node app lives in backend/, and it
# serves public/ and admin-panel/ as static files by walking up from its own
# dist/ folder (see backend/src/server.ts, backend/src/lib/renderIndex.ts).
# Liara's buildpack auto-detection scans the repo root for a package.json,
# finds none there, and has nothing to build — this Dockerfile makes the
# build explicit instead of relying on that detection.
FROM node:20-alpine AS build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine
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
# raw-TCP database connections aren't reachable from the dev/test sandbox)
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
