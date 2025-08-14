#!/bin/bash

# Trading Bot - Cloud Run Deployment Script
# Builds Docker image and deploys to Google Cloud Run

set -e  # Exit on any error

# Configuration
PROJECT_ID=${GOOGLE_CLOUD_PROJECT:-""}
REGION=${REGION:-"us-central1"}
SERVICE_NAME=${SERVICE_NAME:-"spx-straddle-bot"}
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"
MEMORY=${MEMORY:-"1Gi"}
CPU=${CPU:-"1"}
TIMEOUT=${TIMEOUT:-"3600s"}  # 1 hour timeout for long-running bot
MAX_INSTANCES=${MAX_INSTANCES:-"1"}
MIN_INSTANCES=${MIN_INSTANCES:-"0"}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 SPX Straddle Bot Cloud Run Deployment${NC}"
echo "========================================"

# Validate required environment
if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}❌ Error: GOOGLE_CLOUD_PROJECT environment variable not set${NC}"
    echo "Please set it with: export GOOGLE_CLOUD_PROJECT=your-project-id"
    exit 1
fi

echo -e "${BLUE}📋 Deployment Configuration:${NC}"
echo "  Project ID: $PROJECT_ID"
echo "  Region: $REGION"
echo "  Service: $SERVICE_NAME"
echo "  Image: $IMAGE_NAME"
echo "  Memory: $MEMORY"
echo "  CPU: $CPU"
echo "  Timeout: $TIMEOUT"
echo "  Max Instances: $MAX_INSTANCES"
echo ""

# Check if gcloud is authenticated
echo -e "${YELLOW}🔐 Checking gcloud authentication...${NC}"
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -n1 > /dev/null; then
    echo -e "${RED}❌ Not authenticated with gcloud. Run: gcloud auth login${NC}"
    exit 1
fi
echo -e "${GREEN}✅ gcloud authenticated${NC}"

# Set the project
echo -e "${YELLOW}📂 Setting gcloud project...${NC}"
gcloud config set project $PROJECT_ID

# Enable required APIs
echo -e "${YELLOW}🔧 Enabling required APIs...${NC}"
gcloud services enable \
    cloudbuild.googleapis.com \
    run.googleapis.com \
    containerregistry.googleapis.com \
    secretmanager.googleapis.com \
    cloudscheduler.googleapis.com

# Navigate to project root for Docker build
cd "$(dirname "$0")/.."

echo -e "${YELLOW}🐳 Building Docker image...${NC}"
echo "Building from: $(pwd)"

# Build the Docker image
docker build \
    -f cloud-run-service/Dockerfile \
    -t $IMAGE_NAME \
    --platform linux/amd64 \
    .

echo -e "${GREEN}✅ Docker image built successfully${NC}"

# Push to Container Registry
echo -e "${YELLOW}📤 Pushing image to Container Registry...${NC}"
docker push $IMAGE_NAME

echo -e "${GREEN}✅ Image pushed successfully${NC}"

# Deploy to Cloud Run with your existing secrets
echo -e "${YELLOW}☁️  Deploying to Cloud Run with secrets...${NC}"
echo -e "${BLUE}Using secrets: ts_client_id, ts_client_secret, ts_refresh_token${NC}"

gcloud run deploy $SERVICE_NAME \
    --image $IMAGE_NAME \
    --platform managed \
    --region $REGION \
    --allow-unauthenticated \
    --memory $MEMORY \
    --cpu $CPU \
    --timeout $TIMEOUT \
    --max-instances $MAX_INSTANCES \
    --min-instances $MIN_INSTANCES \
    --set-env-vars "NODE_ENV=production,RUNNING_IN_CLOUD=true,SPX_SYMBOL=\$SPXW.X,ENTRY_TIME=09:33,TARGET_PROFIT=20,EXIT_TIME=15:50,MAX_POSITION_VALUE=10000,PAPER_TRADING=true" \
    --set-secrets "TRADESTATION_CLIENT_ID=ts_client_id:latest,TRADESTATION_CLIENT_SECRET=ts_client_secret:latest,TRADESTATION_REFRESH_TOKEN=ts_refresh_token:latest" \
    --port 8080

echo -e "${GREEN}✅ Cloud Run deployment successful!${NC}"

# Get the service URL
SERVICE_URL=$(gcloud run services describe $SERVICE_NAME --region=$REGION --format="value(status.url)")

echo ""
echo -e "${GREEN}🎉 Deployment Complete!${NC}"
echo "========================================"
echo -e "${BLUE}Service URL:${NC} $SERVICE_URL"
echo -e "${BLUE}Health Check:${NC} $SERVICE_URL/health"
echo -e "${BLUE}Start Bot:${NC} curl -X POST $SERVICE_URL/start"
echo -e "${BLUE}Stop Bot:${NC} curl -X POST $SERVICE_URL/stop"
echo ""

# Test health endpoint
echo -e "${YELLOW}🏥 Testing health endpoint...${NC}"
if curl -s -o /dev/null -w "%{http_code}" "$SERVICE_URL/health" | grep -q "503"; then
    echo -e "${GREEN}✅ Health endpoint responding (service stopped - ready for scheduler)${NC}"
else
    echo -e "${YELLOW}⚠️  Health endpoint check completed${NC}"
fi

echo ""
echo -e "${BLUE}Next Steps:${NC}"
echo "1. Set up secrets: ./setup-secrets.sh"
echo "2. Configure scheduler: ./scheduler-setup.sh"
echo "3. Monitor logs: gcloud logging read \"resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE_NAME\" --limit 50"
echo ""
echo -e "${GREEN}🎯 Ready for market hours operation!${NC}"