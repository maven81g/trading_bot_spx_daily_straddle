# Multi-stage Docker build for Trading Bot
# Stage 1: Build TypeScript code
FROM node:18-alpine AS builder

# Install timezone data
RUN apk add --no-cache tzdata

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code (only what's needed for compilation)
COPY src/ ./src/

# Build TypeScript to JavaScript
RUN npm run build

# Stage 2: Production runtime
FROM node:18-alpine AS runtime

# Install dumb-init for proper signal handling and timezone data
RUN apk add --no-cache dumb-init tzdata

# Set timezone (change America/New_York to your timezone)
ENV TZ=America/New_York
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S trading-bot -u 1001

# Set working directory
WORKDIR /app

# Copy built application from builder stage
COPY --from=builder --chown=trading-bot:nodejs /app/dist ./dist
COPY --from=builder --chown=trading-bot:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=trading-bot:nodejs /app/package*.json ./

# Set environment to enable Cloud Run mode
ENV RUNNING_IN_CLOUD=true
ENV NODE_ENV=production

# Create logs directory
RUN mkdir -p logs && chown trading-bot:nodejs logs

# Switch to non-root user
USER trading-bot

# Expose port for health checks
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:8080/health || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the main app with Cloud Run mode enabled
CMD ["node", "dist/index.js"]