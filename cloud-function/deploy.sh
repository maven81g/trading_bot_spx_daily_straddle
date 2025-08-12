#!/bin/bash

# SPX Daily Trader - Cloud Function Deployment Script

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 SPX Daily Trader - Cloud Function Deployment${NC}"
echo "=================================================="

# Check if required environment variables are set
REQUIRED_VARS=("GOOGLE_CLOUD_PROJECT" "ts_client_id" "ts_client_secret" "ts_refresh_token" "mailgun_api_key")

echo -e "${YELLOW}📋 Checking environment variables...${NC}"
for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        echo -e "${RED}❌ Error: $var is not set${NC}"
        echo "Please set all required environment variables or update the deployment script"
        exit 1
    else
        echo -e "${GREEN}✅ $var is set${NC}"
    fi
done

# Set default values
FUNCTION_NAME=${FUNCTION_NAME:-"spx-daily-trader"}
REGION=${REGION:-"us-central1"}
MEMORY=${MEMORY:-"512MB"}
TIMEOUT=${TIMEOUT:-"540s"}
RUNTIME=${RUNTIME:-"nodejs18"}

echo ""
echo -e "${BLUE}📦 Deployment Configuration:${NC}"
echo "Function Name: $FUNCTION_NAME"
echo "Region: $REGION"
echo "Memory: $MEMORY"
echo "Timeout: $TIMEOUT"
echo "Runtime: $RUNTIME"
echo "Project: $GOOGLE_CLOUD_PROJECT"

# Deploy the Cloud Function
echo ""
echo -e "${YELLOW}🚀 Deploying Cloud Function...${NC}"

gcloud functions deploy $FUNCTION_NAME \
    --runtime $RUNTIME \
    --trigger-http \
    --entry-point main \
    --memory $MEMORY \
    --timeout $TIMEOUT \
    --region $REGION \
    --set-env-vars "GOOGLE_CLOUD_PROJECT=$GOOGLE_CLOUD_PROJECT,BIGQUERY_DATASET=spx_trading,ts_client_id=$ts_client_id,ts_client_secret=$ts_client_secret,ts_refresh_token=$ts_refresh_token,mailgun_api_key=$mailgun_api_key,CLOUD_FUNCTION_VERSION=1.0.0" \
    --allow-unauthenticated

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Cloud Function deployed successfully!${NC}"
else
    echo -e "${RED}❌ Cloud Function deployment failed${NC}"
    exit 1
fi

# Get the function URL
FUNCTION_URL=$(gcloud functions describe $FUNCTION_NAME --region=$REGION --format="value(httpsTrigger.url)")
echo -e "${GREEN}🌐 Function URL: $FUNCTION_URL${NC}"

# Create or update Cloud Scheduler job
echo ""
echo -e "${YELLOW}⏰ Setting up Cloud Scheduler...${NC}"

SCHEDULER_JOB_NAME="spx-daily-trading"
SCHEDULE="30 21 * * 1-5"  # 4:30 PM EST (9:30 PM UTC) on weekdays
TIMEZONE="America/New_York"

# Check if scheduler job exists
if gcloud scheduler jobs describe $SCHEDULER_JOB_NAME --location=$REGION >/dev/null 2>&1; then
    echo "Updating existing scheduler job..."
    gcloud scheduler jobs update http $SCHEDULER_JOB_NAME \
        --location=$REGION \
        --schedule="$SCHEDULE" \
        --uri="$FUNCTION_URL" \
        --http-method=POST \
        --time-zone="$TIMEZONE"
else
    echo "Creating new scheduler job..."
    gcloud scheduler jobs create http $SCHEDULER_JOB_NAME \
        --location=$REGION \
        --schedule="$SCHEDULE" \
        --uri="$FUNCTION_URL" \
        --http-method=POST \
        --time-zone="$TIMEZONE"
fi

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Cloud Scheduler configured successfully!${NC}"
    echo -e "${GREEN}📅 Schedule: $SCHEDULE ($TIMEZONE)${NC}"
else
    echo -e "${YELLOW}⚠️  Cloud Scheduler setup failed (you may need to enable the API)${NC}"
fi

# Test the function
echo ""
echo -e "${YELLOW}🧪 Testing the function...${NC}"
echo "You can test the function manually with:"
echo "curl -X POST $FUNCTION_URL"
echo ""
echo "Or test with a specific date:"
echo "curl -X POST \"$FUNCTION_URL?date=2025-07-31\""

echo ""
echo -e "${GREEN}🎉 Deployment completed successfully!${NC}"
echo ""
echo -e "${BLUE}📊 Next Steps:${NC}"
echo "1. The function will run automatically on weekdays at 4:30 PM EST"
echo "2. Check BigQuery dataset 'spx_trading' for stored results"
echo "3. Monitor Cloud Function logs for execution details"
echo "4. Email summaries will be sent to: $EMAIL_TO"
echo ""
echo -e "${BLUE}📈 Useful Commands:${NC}"
echo "View logs: gcloud functions logs read $FUNCTION_NAME --region=$REGION"
echo "View scheduler jobs: gcloud scheduler jobs list --location=$REGION"
echo "Trigger manually: gcloud scheduler jobs run $SCHEDULER_JOB_NAME --location=$REGION"