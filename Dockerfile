FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm install --production

# Copy source
COPY . .

EXPOSE 3000

# Default command: start the server
CMD ["node", "src/server.js"]
