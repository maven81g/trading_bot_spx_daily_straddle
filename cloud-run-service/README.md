# Trading Bot - Cloud Run Service Deployment

## Architecture Overview

**Cloud Run Service** deployment for continuous trading bot operation during market hours (9:25 AM - 4:00 PM EST).

```
Cloud Scheduler (9:25 AM EST) 
    ↓ HTTP POST /start
Cloud Run Service (Trading Bot)
    ↓ Runs continuously 
    ↓ Health checks /health
    ↓ Graceful shutdown /stop or 4:00 PM EST
Auto-scales to zero when stopped
```

## Components

- **Cloud Run Service**: Long-running trading bot (up to 6+ hours)
- **Cloud Scheduler**: Daily startup trigger at 9:25 AM EST
- **Secret Manager**: TradeStation API credentials
- **Cloud Logging**: Centralized bot logs
- **Docker**: Multi-stage build for TypeScript bot

## Files

- `Dockerfile` - Multi-stage TypeScript build
- `deploy.sh` - Local Docker deployment script
- `cloud-run.yaml` - Cloud Run service configuration
- `scheduler-setup.sh` - Cloud Scheduler setup
- `package.json` - Simplified bot dependencies
- `bot-service.ts` - HTTP health endpoint wrapper
- `.dockerignore` - Docker build exclusions
- `.env.example` - Environment variables template

## Deployment Process

1. **Setup**: Configure GCP project and enable APIs
2. **Build**: Docker build with TypeScript compilation
3. **Deploy**: Push to Container Registry and deploy to Cloud Run
4. **Schedule**: Setup Cloud Scheduler for daily startup
5. **Monitor**: Cloud Logging and health checks

## Estimated Costs

- **Cloud Run**: ~$10-20/month (6.5 hours/day, 20 trading days)
- **Container Registry**: ~$1/month (image storage)
- **Cloud Scheduler**: Free tier (1 job)
- **Secret Manager**: Free tier (small secrets)

**Total**: ~$11-21/month

## Quick Start

```bash
# 1. Setup GCP project
gcloud config set project YOUR_PROJECT_ID

# 2. Enable APIs  
./setup-gcp.sh

# 3. Store secrets
./setup-secrets.sh

# 4. Deploy bot
./deploy.sh

# 5. Setup scheduler
./scheduler-setup.sh
```

## Market Hours Operation

- **9:25 AM EST**: Cloud Scheduler triggers `/start` endpoint
- **9:25-4:00 PM**: Bot runs continuously, processing real-time data
- **4:00 PM EST**: Bot auto-shutdowns after market close
- **After 4:00 PM**: Cloud Run scales to zero (no cost)

## Monitoring

- **Health Check**: `GET /health` - Bot status and performance
- **Logs**: Cloud Logging integration
- **Metrics**: Cloud Run built-in metrics
- **Alerts**: Optional error rate/latency alerts

## Local Development

```bash
# Run bot locally with same environment
docker build -t trading-bot .
docker run -p 8080:8080 --env-file .env trading-bot

# Test health endpoint
curl http://localhost:8080/health
```