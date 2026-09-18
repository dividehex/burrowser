FROM node:26-bookworm-slim@sha256:c8fedd782bcd1b68d8a7d1ed2577b5f820eba820871323f605292651ff11e3c6
WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
COPY db/migrations ./db/migrations
RUN useradd --create-home --uid 10001 app && chown -R app:app /app
USER 10001
ENV HOME=/home/app NODE_ENV=production PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "--experimental-strip-types", "src/server.ts"]
