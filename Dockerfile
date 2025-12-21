# Use Node.js LTS version
FROM node:20-slim

# Install system dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libc6-dev \
    libpng-dev \
    libjpeg-dev \
    libgif-dev \
    libwebp-dev \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-vie \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Set environment to production
ENV NODE_ENV=production

# Copy lockfile trước để cache dependency layer
COPY package.json package-lock.json ./

# Prefer npm ci; fallback to npm install if lockfile mismatch
RUN npm ci --omit=dev || npm install --omit=dev

# Copy toàn bộ project
COPY . .dã 

# Build mbbank module nếu có src/ (cần devDependencies để build)
WORKDIR /app/mbbank
RUN if [ -d "src" ]; then \
      npm install && npm run build; \
    else \
      echo "mbbank/dist/ already exists, skipping build"; \
    fi

# Quay lại working directory chính
WORKDIR /app

# Create directory for data files if needed
RUN mkdir -p /app/data

# Run the bot
CMD ["npm", "start"]

