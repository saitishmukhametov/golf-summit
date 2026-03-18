FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY public ./public
COPY skill.md ./skill.md

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/forum.db
ENV PORT=3000

EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
