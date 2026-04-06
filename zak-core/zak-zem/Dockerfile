# Stage 1: Build Frontend
FROM node:20-alpine AS build-frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Backend & Final Image
FROM node:20-alpine
WORKDIR /app

# Install dependencies for backend
COPY zak-zem/backend/package*.json ./zak-zem/backend/
RUN cd zak-zem/backend && npm install

# Copy backend source
COPY zak-zem/backend/ ./zak-zem/backend/
COPY src/ ./src/
COPY sigils/ ./sigils/

# Copy built frontend to backend/public for static serving
COPY --from=build-frontend /app/frontend/dist ./zak-zem/backend/public

EXPOSE 3001

CMD ["node", "zak-zem/backend/src/server.ts"]

