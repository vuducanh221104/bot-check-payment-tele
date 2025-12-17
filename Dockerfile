FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

COPY . .

# Rebuild native modules để đảm bảo tương thích với Linux
RUN npm rebuild sharp --build-from-source || true

ENV NODE_ENV=production

CMD ["npm", "start"]



WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

COPY . .

# Rebuild native modules để đảm bảo tương thích với Linux
RUN npm rebuild sharp --build-from-source || true

ENV NODE_ENV=production

CMD ["npm", "start"]



WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

COPY . .

# Rebuild native modules để đảm bảo tương thích với Linux
RUN npm rebuild sharp --build-from-source || true

ENV NODE_ENV=production

CMD ["npm", "start"]



WORKDIR /app

COPY package*.json ./
RUN npm install --only=production

COPY . .

# Rebuild native modules để đảm bảo tương thích với Linux
RUN npm rebuild sharp --build-from-source || true

ENV NODE_ENV=production

CMD ["npm", "start"]


