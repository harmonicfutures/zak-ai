# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Runtime (Minimal)
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Copy only what is needed
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

# Install production deps only (if any exist later)
RUN npm ci --omit=dev

# Non-root user for security
USER node

EXPOSE 8080

CMD ["node", "dist/index.js"]

