FROM node:20-slim

# Install Python + yt-dlp (needed for YouTube transcript fetching)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    --no-install-recommends && \
    python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Make yt-dlp available as `python -m yt_dlp`
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHON="/opt/venv/bin/python3"

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Create sessions directory for persistent data
RUN mkdir -p sessions

EXPOSE 3000

CMD ["node", "dist/index.js"]
