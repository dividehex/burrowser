FROM mcr.microsoft.com/playwright:v1.61.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends x11vnc && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY src ./src
COPY entrypoint.sh ./entrypoint.sh
RUN useradd --create-home --uid 10001 browser && mkdir -p /profile/chromium /tmp/runtime && chown -R browser:browser /app /profile /tmp/runtime
RUN sandbox_helper="$(find /ms-playwright -type f -name chrome_sandbox -print -quit)" && test -n "$sandbox_helper" && chown root:root "$sandbox_helper" && chmod 4755 "$sandbox_helper" && ln -s chrome_sandbox "$(dirname "$sandbox_helper")/chrome-sandbox"
RUN chmod 0555 /app/entrypoint.sh
USER 10001
ENV HOME=/home/browser XDG_RUNTIME_DIR=/tmp/runtime DISPLAY=:99
EXPOSE 8080 5900
ENTRYPOINT ["/app/entrypoint.sh"]
