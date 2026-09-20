FROM node:22-alpine AS deps
WORKDIR /app
# Optional registry mirror (e.g. https://registry.npmmirror.com) for networks
# where registry.npmjs.org is flaky. Pass via build args; empty keeps defaults.
ARG NPM_REGISTRY=
RUN if [ -n "$NPM_REGISTRY" ]; then export COREPACK_NPM_REGISTRY="$NPM_REGISTRY" npm_config_registry="$NPM_REGISTRY"; fi \
 && corepack enable
COPY package.json pnpm-lock.yaml ./
ENV npm_config_registry=${NPM_REGISTRY}
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# git: read-only workspace observation (status/diff). curl kept small; node fetch is used otherwise.
RUN apk add --no-cache git
ARG NPM_REGISTRY=
ENV npm_config_registry=${NPM_REGISTRY}
RUN if [ -n "$NPM_REGISTRY" ]; then export COREPACK_NPM_REGISTRY="$NPM_REGISTRY"; fi \
 && corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
EXPOSE 8787
CMD ["node", "dist/server/index.js"]
