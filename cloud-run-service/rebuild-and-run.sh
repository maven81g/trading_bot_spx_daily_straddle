#!/bin/bash

# Trading Bot - Docker Rebuild and Run Script
# Rebuilds the Docker image and runs the container locally

set -e

# Configuration
IMAGE_NAME="trading-bot-local"
CONTAINER_NAME="trading-bot-test"
PORT=8080

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🐳 Trading Bot - Docker Rebuild and Run${NC}"
echo "========================================"

# Navigate to project root
cd "$(dirname "$0")/.."

# Check if .env exists in cloud-run-service
if [ ! -f "cloud-run-service/.env" ]; then
    echo -e "${YELLOW}⚠️  .env file not found in cloud-run-service directory${NC}"
    echo "Creating .env from env.example..."
    
    if [ -f "env.example" ]; then
        cp env.example cloud-run-service/.env
        echo -e "${GREEN}✅ Created .env file - Please edit it with your credentials${NC}"
        echo -e "${RED}❌ Exiting - Please configure cloud-run-service/.env before running${NC}"
        exit 1
    else
        echo -e "${RED}❌ env.example not found${NC}"
        exit 1
    fi
fi

# Step 1: Stop and remove existing container
echo -e "${YELLOW}🧹 Cleaning up existing container...${NC}"
if [ "$(docker ps -q -f name=$CONTAINER_NAME)" ]; then
    echo "Stopping running container..."
    docker stop $CONTAINER_NAME
fi

if [ "$(docker ps -aq -f name=$CONTAINER_NAME)" ]; then
    echo "Removing existing container..."
    docker rm $CONTAINER_NAME
fi

# Step 2: Remove old image
echo -e "${YELLOW}🗑️  Removing old Docker image...${NC}"
if [ "$(docker images -q $IMAGE_NAME)" ]; then
    docker rmi $IMAGE_NAME
    echo -e "${GREEN}✅ Old image removed${NC}"
else
    echo "No existing image found"
fi

# Step 3: Build new Docker image
echo -e "${YELLOW}🔨 Building new Docker image...${NC}"
docker build \
    -f cloud-run-service/Dockerfile \
    -t $IMAGE_NAME \
    . || {
    echo -e "${RED}❌ Docker build failed${NC}"
    exit 1
}

echo -e "${GREEN}✅ Docker image built successfully${NC}"

# Step 4: Run the container
echo -e "${YELLOW}🚀 Starting Docker container...${NC}"
docker run -d \
    --name $CONTAINER_NAME \
    --env-file cloud-run-service/.env \
    -p $PORT:8080 \
    $IMAGE_NAME || {
    echo -e "${RED}❌ Failed to start container${NC}"
    exit 1
}

echo -e "${GREEN}✅ Container started${NC}"

# Step 5: Wait for service to be ready
echo -e "${YELLOW}⏳ Waiting for service to be ready...${NC}"
MAX_ATTEMPTS=30
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if curl -s http://localhost:$PORT/health > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Service is ready!${NC}"
        break
    else
        ATTEMPT=$((ATTEMPT + 1))
        echo -e "Attempt $ATTEMPT/$MAX_ATTEMPTS - waiting..."
        sleep 2
    fi
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    echo -e "${RED}❌ Service failed to start after 60 seconds${NC}"
    echo -e "${YELLOW}📋 Container logs:${NC}"
    docker logs $CONTAINER_NAME
    exit 1
fi

# Step 6: Show service status
echo ""
echo -e "${GREEN}🎉 Container is running successfully!${NC}"
echo "========================================"
echo -e "${BLUE}Service Information:${NC}"
echo -e "  Container: ${GREEN}$CONTAINER_NAME${NC}"
echo -e "  Port: ${GREEN}$PORT${NC}"
echo ""

# Step 7: Test endpoints
echo -e "${BLUE}📍 Available Endpoints:${NC}"
echo "  http://localhost:$PORT/         - Service info"
echo "  http://localhost:$PORT/health   - Health check"
echo "  http://localhost:$PORT/status   - Bot status"
echo "  http://localhost:$PORT/start    - Start bot (POST)"
echo "  http://localhost:$PORT/stop     - Stop bot (POST)"
echo ""

# Step 8: Quick health check
echo -e "${BLUE}🏥 Health Check:${NC}"
curl -s http://localhost:$PORT/health | jq . 2>/dev/null || curl -s http://localhost:$PORT/health
echo ""

# Step 9: Show initial status
echo -e "${BLUE}📊 Initial Status:${NC}"
curl -s http://localhost:$PORT/status | jq . 2>/dev/null || curl -s http://localhost:$PORT/status
echo ""

# Step 10: Show logs
echo -e "${BLUE}📋 Recent Container Logs:${NC}"
docker logs --tail 10 $CONTAINER_NAME
echo ""

# Instructions
echo -e "${GREEN}✅ Setup Complete!${NC}"
echo "========================================"
echo -e "${BLUE}Useful Commands:${NC}"
echo "  View live logs:    docker logs -f $CONTAINER_NAME"
echo "  Check status:      curl http://localhost:$PORT/status"
echo "  Start bot:         curl -X POST http://localhost:$PORT/start"
echo "  Stop bot:          curl -X POST http://localhost:$PORT/stop"
echo "  Stop container:    docker stop $CONTAINER_NAME"
echo "  Remove container:  docker rm $CONTAINER_NAME"
echo ""
echo -e "${YELLOW}💡 Tip:${NC} Open a new terminal and run: docker logs -f $CONTAINER_NAME"
echo "        to see real-time logs and dashboard output"