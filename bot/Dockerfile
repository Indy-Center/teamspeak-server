# teamspeak-bot. Built by CI and pushed to ghcr.io/indy-center/teamspeak-bot on main.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# No install scripts: nothing the bot uses needs one (ssh2's optional native parts aren't used over raw ServerQuery).
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/main.js"]
