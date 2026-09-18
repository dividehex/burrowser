FROM mcr.microsoft.com/playwright:v1.61.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends x11vnc && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
# @playwright/mcp pins an exact Playwright build, and that build needs its own Chromium. The base image
# supplies the system libraries; its bundled (different-version) browsers are dropped in favour of this one.
RUN rm -rf /ms-playwright/* && npx playwright install chromium
COPY src ./src
COPY entrypoint.sh ./entrypoint.sh
RUN useradd --create-home --uid 10001 browser && mkdir -p /profile/chromium /tmp/runtime && chown -R browser:browser /app /profile /tmp/runtime
RUN found=0; for helper in $(find /ms-playwright -type f -name chrome_sandbox); do found=1; chown root:root "$helper" && chmod 4755 "$helper" && ln -sf chrome_sandbox "$(dirname "$helper")/chrome-sandbox"; done; test "$found" = 1
RUN chmod 0555 /app/entrypoint.sh
USER 10001
ENV HOME=/home/browser XDG_RUNTIME_DIR=/tmp/runtime DISPLAY=:99
EXPOSE 8080 5900
ENTRYPOINT ["/app/entrypoint.sh"]
