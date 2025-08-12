#!/bin/bash

# Trading Bot - Local Testing Script
# Test the Docker container locally before deploying

set -e

# Configuration
IMAGE_NAME="trading-bot-local"
CONTAINER_NAME="trading-bot-test"
PORT=8080

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🐳 Trading Bot - Local Docker Test${NC}"
echo "===================================="

# Check if .env exists
if [ ! -f ".env" ]; then
    echo -e "${RED}❌ .env file not found${NC}"
    echo "Please copy .env.example to .env and fill in your credentials"
    exit 1
fi

echo -e "${BLUE}Environment:${NC} Using .env file"

# Navigate to project root
cd "$(dirname "$0")/.."

# Stop and remove existing container if running
echo -e "${YELLOW}🧹 Cleaning up existing containers...${NC}"
docker stop $CONTAINER_NAME 2>/dev/null || true
docker rm $CONTAINER_NAME 2>/dev/null || true

# Build the image
echo -e "${YELLOW}🔨 Building Docker image...${NC}"
docker build \
    -f cloud-run-service/Dockerfile \
    -t $IMAGE_NAME \
    .

echo -e "${GREEN}✅ Image built successfully${NC}"

# Run the container
echo -e "${YELLOW}🚀 Starting container...${NC}"
docker run -d \
    --name $CONTAINER_NAME \
    --env-file cloud-run-service/.env \
    -p $PORT:8080 \
    $IMAGE_NAME

echo -e "${GREEN}✅ Container started${NC}"

# Wait for container to be ready
echo -e "${YELLOW}⏳ Waiting for service to be ready...${NC}"
sleep 5

# Test health endpoint
echo -e "${YELLOW}🏥 Testing health endpoint...${NC}"
for i in {1..10}; do
    if curl -s http://localhost:$PORT/health > /dev/null; then
        echo -e "${GREEN}✅ Health endpoint responding${NC}"
        break
    else
        echo -e "${YELLOW}⏳ Attempt $i/10 - waiting...${NC}"
        sleep 2
    fi
    
    if [ $i -eq 10 ]; then
        echo -e "${RED}❌ Health endpoint not responding after 20 seconds${NC}"
        echo -e "${YELLOW}📋 Container logs:${NC}"
        docker logs $CONTAINER_NAME
        exit 1
    fi
done

# Show service info
echo ""
echo -e "${GREEN}🎉 Container is running successfully!${NC}"
echo "===================================="
echo -e "${BLUE}Container:${NC} $CONTAINER_NAME"
echo -e "${BLUE}Port:${NC} $PORT"
echo ""

# Test endpoints
echo -e "${BLUE}🔍 Testing endpoints:${NC}"

echo -e "${YELLOW}1. Root endpoint:${NC}"
curl -s http://localhost:$PORT/ | jq . || curl -s http://localhost:$PORT/

echo -e "\n${YELLOW}2. Health check:${NC}"
curl -s http://localhost:$PORT/health | jq . || curl -s http://localhost:$PORT/health

echo -e "\n${YELLOW}3. Status:${NC}"
curl -s http://localhost:$PORT/status | jq . || curl -s http://localhost:$PORT/status

# Optional: Test start endpoint
echo ""
read -p "Do you want to test starting the bot? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}🚀 Testing bot start...${NC}"
    curl -X POST -H "Content-Type: application/json" \
         -d '{"reason":"Local test"}' \
         http://localhost:$PORT/start | jq . || echo "Start request sent"
         
    sleep 3
    
    echo -e "${YELLOW}📊 Updated status:${NC}"
    curl -s http://localhost:$PORT/status | jq . || curl -s http://localhost:$PORT/status
    
    echo ""
    read -p "Stop the bot? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${YELLOW}🛑 Testing bot stop...${NC}"
        curl -X POST -H "Content-Type: application/json" \
             -d '{"reason":"Local test stop"}' \
             http://localhost:$PORT/stop | jq . || echo "Stop request sent"
    fi
fi

# Show logs
echo ""
echo -e "${BLUE}📋 Recent container logs:${NC}"
docker logs --tail 20 $CONTAINER_NAME

# Instructions
echo ""
echo -e "${GREEN}🎯 Local test complete!${NC}"
echo "========================="
echo -e "${BLUE}Useful commands:${NC}"
echo "  View logs: docker logs -f $CONTAINER_NAME"
echo "  Stop container: docker stop $CONTAINER_NAME"
echo "  Remove container: docker rm $CONTAINER_NAME"
echo "  Health check: curl http://localhost:$PORT/health"
echo ""
echo -e "${BLUE}Next steps:${NC}"
echo "  1. If everything looks good, deploy: ./deploy.sh"
echo "  2. Setup secrets: ./setup-secrets.sh"
echo "  3. Configure scheduler: ./scheduler-setup.sh"

# Keep container running or stop it
echo ""
read -p "Keep container running for further testing? (Y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo -e "${YELLOW}🧹 Stopping and removing container...${NC}"
    docker stop $CONTAINER_NAME
    docker rm $CONTAINER_NAME
    echo -e "${GREEN}✅ Container cleaned up${NC}"
else
    echo -e "${GREEN}✅ Container is still running for further testing${NC}"
fi