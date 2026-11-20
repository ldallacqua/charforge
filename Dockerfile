# Charforge studio: API + web app + in-process render worker (network backends).
# The Codex CLI backend runs on the machine where the CLI is installed: use `forge worker` there.
# Python (numpy, pillow, OpenCV 4) is here for the finishing step's cut and join (tools/tiles.py).
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:24-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/tiles \
 && /opt/tiles/bin/pip install --no-cache-dir numpy pillow 'opencv-python-headless>=4.8,<5'
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 CHARFORGE_DATA=/data CHARFORGE_PYTHON=/opt/tiles/bin/python
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY tools ./tools
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server/main.ts"]
