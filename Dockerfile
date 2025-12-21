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

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy mbbank directory (contains native modules and model)
COPY mbbank ./mbbank

# Copy application files
COPY bot.js ./
COPY index.js ./
COPY *.json ./

# Create directory for data files if needed
RUN mkdir -p /app/data

# Expose port if needed (adjust if your bot uses a port)
# EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production

# Run the bot
CMD ["npm", "start"]

