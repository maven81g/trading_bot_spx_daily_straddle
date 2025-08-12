#!/bin/bash

# Trading Bot - GCP Project Setup Script
# Enables APIs and creates service accounts

set -e

PROJECT_ID=${GOOGLE_CLOUD_PROJECT:-""}
REGION=${REGION:-"us-central1"}
SERVICE_ACCOUNT_NAME="trading-bot-service-account"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🔧 Trading Bot - GCP Setup${NC}"
echo "=============================="

# Validate project ID
if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}❌ Error: GOOGLE_CLOUD_PROJECT not set${NC}"
    echo "Run: export GOOGLE_CLOUD_PROJECT=your-project-id"
    exit 1
fi

echo -e "${BLUE}Project ID:${NC} $PROJECT_ID"
echo -e "${BLUE}Region:${NC} $REGION"
echo ""

# Set project
gcloud config set project $PROJECT_ID

# Enable APIs
echo -e "${YELLOW}🔌 Enabling required APIs...${NC}"
gcloud services enable \
    cloudbuild.googleapis.com \
    run.googleapis.com \
    containerregistry.googleapis.com \
    secretmanager.googleapis.com \
    cloudscheduler.googleapis.com \
    logging.googleapis.com \
    monitoring.googleapis.com

echo -e "${GREEN}✅ APIs enabled${NC}"

# Create service account
echo -e "${YELLOW}👤 Creating service account...${NC}"
if gcloud iam service-accounts describe $SERVICE_ACCOUNT_EMAIL 2>/dev/null; then
    echo -e "${YELLOW}⚠️  Service account already exists${NC}"
else
    gcloud iam service-accounts create $SERVICE_ACCOUNT_NAME \
        --display-name="Trading Bot Service Account" \
        --description="Service account for trading bot Cloud Run service"
    echo -e "${GREEN}✅ Service account created${NC}"
fi

# Grant necessary roles
echo -e "${YELLOW}🔐 Granting IAM roles...${NC}"
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" \
    --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" \
    --role="roles/logging.logWriter"

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" \
    --role="roles/monitoring.metricWriter"

echo -e "${GREEN}✅ IAM roles granted${NC}"

# Create Cloud Storage bucket for logs (optional)
BUCKET_NAME="${PROJECT_ID}-trading-bot-logs"
echo -e "${YELLOW}🪣 Creating storage bucket for logs...${NC}"
if gsutil ls gs://$BUCKET_NAME 2>/dev/null; then
    echo -e "${YELLOW}⚠️  Bucket already exists${NC}"
else
    gsutil mb -l $REGION gs://$BUCKET_NAME
    echo -e "${GREEN}✅ Storage bucket created${NC}"
fi

# Set default region
echo -e "${YELLOW}🌍 Setting default region...${NC}"
gcloud config set run/region $REGION
gcloud config set compute/region $REGION

echo ""
echo -e "${GREEN}🎉 GCP Setup Complete!${NC}"
echo "================================"
echo -e "${BLUE}Service Account:${NC} $SERVICE_ACCOUNT_EMAIL"
echo -e "${BLUE}Storage Bucket:${NC} gs://$BUCKET_NAME"
echo -e "${BLUE}Region:${NC} $REGION"
echo ""
echo -e "${BLUE}Next Steps:${NC}"
echo "1. Store TradeStation secrets: ./setup-secrets.sh"
echo "2. Deploy the bot: ./deploy.sh"
echo "3. Setup scheduler: ./scheduler-setup.sh"