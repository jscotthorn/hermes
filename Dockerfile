# Multi-stage build for Hermes NestJS service
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig*.json ./

# Install ALL dependencies (including dev) for building
RUN npm ci && npm cache clean --force

# Copy source code
COPY src/ ./src/

# Build the application (with cache bust for debugging)
RUN echo "Build timestamp: $(date)" && npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Install curl for health checks
RUN apk add --no-cache curl

# Copy package files
COPY package*.json ./

# Install ALL dependencies for debugging (temporary)
RUN npm ci && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
# Also copy source for debugging
COPY src/ ./src/
COPY tsconfig*.json ./

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S hermes -u 1001 -G nodejs

# Create necessary directories for the application
RUN mkdir -p /app/data /app/logs

# Change ownership of the app directory
RUN chown -R hermes:nodejs /app
USER hermes

# Health check - just verify the Node process is running
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD pgrep node || exit 1

# Start the application
CMD ["node", "dist/main.js"]