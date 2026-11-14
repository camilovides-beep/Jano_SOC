# --- compilacion ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

# --- ejecucion ---
FROM node:22-alpine
# SQLite integrado de Node (base de interesados) aun avisa que es experimental en Node 22: se silencia ese aviso.
ENV NODE_ENV=production PORT=3000 NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY prompts ./prompts
COPY package.json ./
# Lista de dispositivos del dueño. Montar un volumen en /app/data para que sobreviva a los despliegues.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "dist/main.js"]
