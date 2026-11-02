FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .
RUN pnpm check
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/shared ./shared
RUN mkdir -p /app/uploads /app/.localvoice-private/salesforce && chown -R node:node /app/uploads /app/.localvoice-private

EXPOSE 3000
USER node

CMD ["node", "dist/index.js"]

# Local staging uses the same production bundle, plus TypeScript migration tooling.
FROM runtime AS staging
COPY --from=build /app/server ./server
COPY --from=build /app/tsconfig.json ./tsconfig.json
