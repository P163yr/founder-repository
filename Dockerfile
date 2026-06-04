# Founder Extractor — runs the Node dashboard + Playwright browser.
# (SearXNG runs separately on the same pod; this image does NOT include it.)
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npx playwright install chromium
COPY server.js ./

# Persist results on the mounted volume in production:
#   docker run -e PORT=8080 -v /workspace/founder-data:/workspace ...
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
