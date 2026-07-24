# Multi-stage build for sa-steam-proxy (hostNetwork /28 egress pods)
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build && npm prune --omit=dev --legacy-peer-deps

FROM node:22-alpine AS runtime
ARG APP_VERSION=0.0.4
ARG GIT_SHA=unknown
WORKDIR /app
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA}
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8080
USER node
CMD ["node", "dist/main.js"]
