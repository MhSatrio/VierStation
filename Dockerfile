# VierStation – single-container image (API + built client). Data lives in /app/data (mount a volume).
# VierStation has NO login (it is a local-first desktop-style app). Publish the port to this computer only:
#   docker run -p 127.0.0.1:8787:8787 -v vs-data:/app/data vierstation
# (inside the container it must listen on 0.0.0.0 for the published port to reach it). Requests whose Host header is not localhost are refused (VIERSTATION_ALLOWED_HOSTS adds exceptions).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
# the PDF report embeds the brand font and icon: copy only those two weights and the brand folder (the server itself has no npm dependencies)
COPY --from=build /app/node_modules/@fontsource/jost/files/jost-latin-400-normal.woff /app/node_modules/@fontsource/jost/files/jost-latin-400-normal.woff
COPY --from=build /app/node_modules/@fontsource/jost/files/jost-latin-600-normal.woff /app/node_modules/@fontsource/jost/files/jost-latin-600-normal.woff
COPY public/brand ./public/brand
COPY TERMS.md ./TERMS.md
COPY package.json ./
RUN mkdir -p data && chown -R node:node /app
USER node
VOLUME /app/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
