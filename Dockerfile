FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libnss3 \
      libatk-bridge2.0-0 \
      libgtk-3-0 \
      libxss1 \
      libasound2 \
	  iproute2 \
	  tar \
	  gzip

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY . .
RUN npm install

RUN npx playwright install-deps chromium
RUN npx playwright install chromium

RUN npm install -g @pixlcore/xyrun

RUN rm -rf /var/lib/apt/lists/*

CMD ["xyrun", "node", "index.js"]
