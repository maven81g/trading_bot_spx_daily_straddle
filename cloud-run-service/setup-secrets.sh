#!/bin/bash

# Trading Bot - Secrets Setup Script
# Stores TradeStation API credentials in Google Secret Manager

set -e

PROJECT_ID=${GOOGLE_CLOUD_PROJECT:-""}

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🔐 Trading Bot - Secrets Setup${NC}"
echo "================================="

# Validate project ID
if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}❌ Error: GOOGLE_CLOUD_PROJECT not set${NC}"
    echo "Run: export GOOGLE_CLOUD_PROJECT=your-project-id"
    exit 1
fi

echo -e "${BLUE}Project ID:${NC} $PROJECT_ID"
echo ""

# Function to create or update secret
create_or_update_secret() {
    local secret_name=$1
    local secret_description=$2
    local prompt_text=$3
    
    echo -e "${YELLOW}🔑 Setting up: $secret_name${NC}"
    echo "  Description: $secret_description"
    
    # Check if secret already exists
    if gcloud secrets describe $secret_name 2>/dev/null; then
        echo -e "${YELLOW}⚠️  Secret '$secret_name' already exists${NC}"
        read -p "Do you want to update it with a new value? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${BLUE}ℹ️  Skipping $secret_name${NC}"
            return
        fi
    else
        # Create the secret
        gcloud secrets create $secret_name \
            --description="$secret_description" \
            --replication-policy="automatic"
        echo -e "${GREEN}✅ Secret '$secret_name' created${NC}"
    fi
    
    # Prompt for secret value
    echo "$prompt_text"
    read -s secret_value
    echo
    
    if [ -z "$secret_value" ]; then
        echo -e "${RED}❌ No value provided for $secret_name${NC}"
        return 1
    fi
    
    # Add secret version
    echo "$secret_value" | gcloud secrets versions add $secret_name --data-file=-
    echo -e "${GREEN}✅ Secret value stored for $secret_name${NC}"
    echo
}

# Set project
gcloud config set project $PROJECT_ID

# Enable Secret Manager API if not already enabled
echo -e "${YELLOW}🔌 Ensuring Secret Manager API is enabled...${NC}"
gcloud services enable secretmanager.googleapis.com

# Create secrets
echo -e "${BLUE}Setting up TradeStation API credentials...${NC}"
echo "You'll need to provide your TradeStation API credentials."
echo "Get these from: https://api.tradestation.com/"
echo ""

# TradeStation Client ID
create_or_update_secret "tradestation-client-id" \
    "TradeStation API Client ID" \
    "Enter your TradeStation Client ID:"

# TradeStation Client Secret
create_or_update_secret "tradestation-client-secret" \
    "TradeStation API Client Secret" \
    "Enter your TradeStation Client Secret:"

# TradeStation Refresh Token
create_or_update_secret "tradestation-refresh-token" \
    "TradeStation API Refresh Token for authentication" \
    "Enter your TradeStation Refresh Token:"

echo -e "${GREEN}🎉 Secrets Setup Complete!${NC}"
echo "================================="
echo -e "${BLUE}Created/Updated Secrets:${NC}"
echo "  • tradestation-client-id"
echo "  • tradestation-client-secret" 
echo "  • tradestation-refresh-token"
echo ""

# Verify secrets
echo -e "${YELLOW}🔍 Verifying secrets...${NC}"
for secret in "tradestation-client-id" "tradestation-client-secret" "tradestation-refresh-token"; do
    if gcloud secrets describe $secret >/dev/null 2>&1; then
        VERSION=$(gcloud secrets versions list $secret --limit=1 --format="value(name)")
        echo -e "${GREEN}✅ $secret (version: $VERSION)${NC}"
    else
        echo -e "${RED}❌ $secret${NC}"
    fi
done

echo ""
echo -e "${BLUE}Secret Access:${NC}"
echo "The Cloud Run service will access these secrets automatically."
echo "Service account 'trading-bot-service-account' has been granted access."
echo ""

# Show how to test access
echo -e "${BLUE}Testing Secret Access (Optional):${NC}"
echo "To test if secrets are accessible:"
echo "  gcloud secrets versions access latest --secret=tradestation-client-id"
echo ""

echo -e "${BLUE}Next Steps:${NC}"
echo "1. Deploy the bot: ./deploy.sh"
echo "2. Setup scheduler: ./scheduler-setup.sh"
echo "3. Test the deployment"

# Optional: Test the secrets
echo ""
read -p "Do you want to test secret access now? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}🧪 Testing secret access...${NC}"
    
    CLIENT_ID=$(gcloud secrets versions access latest --secret=tradestation-client-id)
    if [ ${#CLIENT_ID} -gt 10 ]; then
        echo -e "${GREEN}✅ Client ID accessible (${#CLIENT_ID} chars)${NC}"
    else
        echo -e "${RED}❌ Client ID seems too short${NC}"
    fi
    
    CLIENT_SECRET=$(gcloud secrets versions access latest --secret=tradestation-client-secret)
    if [ ${#CLIENT_SECRET} -gt 10 ]; then
        echo -e "${GREEN}✅ Client Secret accessible (${#CLIENT_SECRET} chars)${NC}"
    else
        echo -e "${RED}❌ Client Secret seems too short${NC}"
    fi
    
    REFRESH_TOKEN=$(gcloud secrets versions access latest --secret=tradestation-refresh-token)
    if [ ${#REFRESH_TOKEN} -gt 20 ]; then
        echo -e "${GREEN}✅ Refresh Token accessible (${#REFRESH_TOKEN} chars)${NC}"
    else
        echo -e "${RED}❌ Refresh Token seems too short${NC}"
    fi
fi

echo ""
echo -e "${GREEN}🔐 Secrets are ready for the trading bot!${NC}"