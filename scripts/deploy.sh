#!/bin/bash

# Cloudflare Stats Worker - One-Click Deploy Script
# This script automates the deployment process

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
cat << "EOF"
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   Cloudflare Stats Worker - Auto Deploy Script           ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

# Check if wrangler is installed
echo -e "${YELLOW}[1/5] Checking Wrangler installation...${NC}"
if ! command -v wrangler &> /dev/null; then
    echo -e "${RED}XX Wrangler not found!${NC}"
    echo -e "${YELLOW}Installing Wrangler globally...${NC}"
    npm install -g wrangler
    echo -e "${GREEN}OK Wrangler installed${NC}"
else
    WRANGLER_VERSION=$(wrangler --version)
    echo -e "${GREEN}OK Wrangler found: ${WRANGLER_VERSION}${NC}"
fi

# Login to Cloudflare
echo -e "\n${YELLOW}[2/5] Logging in to Cloudflare...${NC}"
if wrangler whoami &> /dev/null; then
    ACCOUNT_INFO=$(wrangler whoami 2>&1)
    echo -e "${GREEN}OK Already logged in${NC}"
    echo "$ACCOUNT_INFO" | grep -E "Account Name|Account ID" || true
else
    echo -e "${YELLOW}Please complete login in browser...${NC}"
    wrangler login
    echo -e "${GREEN}OK Login successful${NC}"
fi

# Update wrangler.toml
echo -e "\n${YELLOW}[3/5] Updating wrangler.toml...${NC}"
if [ ! -f "wrangler.toml" ]; then
    echo -e "${RED}XX wrangler.toml not found!${NC}"
    exit 1
fi

# Backup original
cp wrangler.toml wrangler.toml.backup

echo -e "${YELLOW}Note: KV PAGE_STATS binding has been removed; no KV IDs to update.${NC}"

echo -e "${GREEN}OK wrangler.toml updated${NC}"

# Ask about D1 setup
echo -e "\n${YELLOW}[4/5] Optional: D1 Database for Top Posts${NC}"
read -p "$(echo -e ${YELLOW}Do you want to enable D1 for /api/top endpoint? [y/N]: ${NC})" -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Creating D1 database...${NC}"
    D1_OUTPUT=$(wrangler d1 create cloudflare-stats-top 2>&1)
    echo "$D1_OUTPUT"
    
    D1_ID=$(echo "$D1_OUTPUT" | grep -oP 'database_id = "\K[^"]+' || echo "")
    
    if [ -z "$D1_ID" ]; then
        echo -e "${YELLOW}! Could not auto-extract D1 ID, please update manually${NC}"
    else
        echo -e "${GREEN}OK D1 ID: ${D1_ID}${NC}"
        
        # Uncomment D1 block in wrangler.toml
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s/# \[\[d1_databases\]\]/[[d1_databases]]/" wrangler.toml
            sed -i '' "s/# binding = \"DB\"/binding = \"DB\"/" wrangler.toml
            sed -i '' "s/# database_name = \"cloudflare-stats-top\"/database_name = \"cloudflare-stats-top\"/" wrangler.toml
            sed -i '' "s/# database_id = \".*\"/database_id = \"$D1_ID\"/" wrangler.toml
        else
            sed -i "s/# \[\[d1_databases\]\]/[[d1_databases]]/" wrangler.toml
            sed -i "s/# binding = \"DB\"/binding = \"DB\"/" wrangler.toml
            sed -i "s/# database_name = \"cloudflare-stats-top\"/database_name = \"cloudflare-stats-top\"/" wrangler.toml
            sed -i "s/# database_id = \".*\"/database_id = \"$D1_ID\"/" wrangler.toml
        fi
        
        # Apply schema
        if [ -f "schema.sql" ]; then
            echo -e "${YELLOW}Applying D1 schema...${NC}"
            wrangler d1 execute cloudflare-stats-top --file=schema.sql
            echo -e "${GREEN}OK D1 schema applied${NC}"
        fi
    fi
else
    echo -e "${BLUE}Skipping D1 setup (you can enable it later)${NC}"
fi

# Deploy
echo -e "\n${YELLOW}[5/5] Deploying to Cloudflare...${NC}"
DEPLOY_OUTPUT=$(wrangler deploy 2>&1)
echo "$DEPLOY_OUTPUT"

# Extract deployment URL
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oP 'https://[^\s]+\.workers\.dev' | head -1)

if [ -z "$WORKER_URL" ]; then
    echo -e "${YELLOW}! Could not extract worker URL from output${NC}"
    WORKER_URL="(check wrangler deploy output above)"
fi

# Success summary
echo -e "\n${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}║       DEPLOYMENT SUCCESSFUL                               ║${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"

echo -e "\n${BLUE}Your Stats API is live at:${NC}"
echo -e "${GREEN}   ${WORKER_URL}${NC}"

echo -e "\n${BLUE}Test endpoints:${NC}"
echo -e "   Health check:  ${YELLOW}curl ${WORKER_URL}/health${NC}"
echo -e "   Get stats:     ${YELLOW}curl '${WORKER_URL}/api/count?url=/test/'${NC}"
echo -e "   Site total:    ${YELLOW}curl '${WORKER_URL}/api/stats'${NC}"

echo -e "\n${BLUE}Next steps:${NC}"
echo -e "   1. (Optional) Bind custom domain in Cloudflare Dashboard:"
echo -e "      Workers & Pages → Triggers → Custom Domains"
echo -e "   2. Update your frontend JS with the Worker URL"
echo -e "   3. Test the integration on your website"

echo -e "\n${BLUE}Documentation:${NC}"
echo -e "   README.md - Full integration guide"
echo -e "   scripts/verify.sh - Health check script"

echo -e "\n${BLUE}Backup created:${NC}"
echo -e "   wrangler.toml.backup (original configuration)"

echo -e "\n${GREEN}Done.${NC}\n"
