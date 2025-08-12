#!/bin/bash

# SPX Daily Trader - Google Secret Manager Setup Script

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔐 SPX Daily Trader - Secret Manager Setup${NC}"
echo "=============================================="

# Check if GOOGLE_CLOUD_PROJECT is set
if [ -z "$GOOGLE_CLOUD_PROJECT" ]; then
    echo -e "${RED}❌ Error: GOOGLE_CLOUD_PROJECT is not set${NC}"
    echo "Please set your Google Cloud project ID:"
    echo "export GOOGLE_CLOUD_PROJECT=your-project-id"
    exit 1
fi

echo -e "${GREEN}✅ Using project: $GOOGLE_CLOUD_PROJECT${NC}"

# Function to create or update a secret
create_or_update_secret() {
    local secret_name=$1
    local secret_description=$2
    
    echo ""
    echo -e "${YELLOW}🔐 Setting up secret: $secret_name${NC}"
    echo "Description: $secret_description"
    
    # Check if secret exists
    if gcloud secrets describe $secret_name --project=$GOOGLE_CLOUD_PROJECT >/dev/null 2>&1; then
        echo -e "${YELLOW}Secret $secret_name already exists${NC}"
        read -p "Do you want to add a new version? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Skipping $secret_name"
            return
        fi
    else
        echo "Creating new secret: $secret_name"
        gcloud secrets create $secret_name \
            --project=$GOOGLE_CLOUD_PROJECT \
            --replication-policy="automatic"
    fi
    
    # Prompt for secret value
    echo -e "${YELLOW}Enter value for $secret_name:${NC}"
    if [[ $secret_name == *"token"* ]] || [[ $secret_name == *"key"* ]]; then
        read -s secret_value  # Hide input for sensitive values
        echo ""
    else
        read secret_value
    fi
    
    if [ -z "$secret_value" ]; then
        echo -e "${RED}❌ No value provided, skipping $secret_name${NC}"
        return
    fi
    
    # Add secret version
    echo "$secret_value" | gcloud secrets versions add $secret_name \
        --project=$GOOGLE_CLOUD_PROJECT \
        --data-file=-
    
    echo -e "${GREEN}✅ Secret $secret_name updated successfully${NC}"
}

# Create all required secrets
echo -e "${BLUE}Creating required secrets for SPX Daily Trader...${NC}"

create_or_update_secret "tradestation-refresh-token" "TradeStation API refresh token for authentication"

create_or_update_secret "mailgun-api-key" "Mailgun API key for sending email reports"

create_or_update_secret "mailgun-domain" "Mailgun domain for sending emails (e.g., mg.yourdomain.com)"

create_or_update_secret "email-to" "Email address to receive daily trading reports"

create_or_update_secret "email-from" "From email address for trading reports (e.g., trading-bot@yourdomain.com)"

echo ""
echo -e "${GREEN}🎉 Secret Manager setup completed!${NC}"

# List created secrets
echo ""
echo -e "${BLUE}📋 Created secrets:${NC}"
gcloud secrets list --project=$GOOGLE_CLOUD_PROJECT --filter="name:tradestation-refresh-token OR name:mailgun-api-key OR name:mailgun-domain OR name:email-to OR name:email-from"

echo ""
echo -e "${BLUE}🔧 Next Steps:${NC}"
echo "1. Verify your secrets are correct:"
echo "   gcloud secrets versions access latest --secret=tradestation-refresh-token --project=$GOOGLE_CLOUD_PROJECT"
echo ""
echo "2. Deploy the Cloud Function:"
echo "   ./deploy.sh"
echo ""
echo "3. Test the function:"
echo "   curl -X POST https://us-central1-$GOOGLE_CLOUD_PROJECT.cloudfunctions.net/spx-daily-trader"

echo ""
echo -e "${YELLOW}⚠️  Security Notes:${NC}"
echo "- Never commit these secret values to version control"
echo "- Regularly rotate your API keys and tokens"
echo "- Monitor Secret Manager access logs"
echo "- Use least-privilege IAM permissions"