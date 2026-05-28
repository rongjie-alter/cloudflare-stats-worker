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
echo -e "${YELLOW}[1/7] Checking Wrangler installation...${NC}"
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
echo -e "\n${YELLOW}[2/7] Logging in to Cloudflare...${NC}"
if wrangler whoami &> /dev/null; then
    ACCOUNT_INFO=$(wrangler whoami 2>&1)
    echo -e "${GREEN}OK Already logged in${NC}"
    echo "$ACCOUNT_INFO" | grep -E "Account Name|Account ID" || true
else
    echo -e "${YELLOW}Please complete login in browser...${NC}"
    wrangler login
    echo -e "${GREEN}OK Login successful${NC}"
fi

# Create KV namespace for production
echo -e "\n${YELLOW}[3/7] Creating KV namespace (production)...${NC}"
KV_OUTPUT=$(wrangler kv namespace create PAGE_STATS 2>&1)
echo "$KV_OUTPUT"

if echo "$KV_OUTPUT" | grep -q "already exists"; then
    echo -e "${YELLOW}! Namespace already exists, fetching existing ID...${NC}"
    KV_ID=$(wrangler kv namespace list | jq -r '.[] | select(.title=="PAGE_STATS") | .id' | head -1)
else
    KV_ID=$(echo "$KV_OUTPUT" | grep -oP 'id = "\K[^"]+' || echo "")
fi

if [ -z "$KV_ID" ]; then
    echo -e "${RED}XX Failed to get KV namespace ID${NC}"
    exit 1
fi
echo -e "${GREEN}OK Production KV ID: ${KV_ID}${NC}"

# Create KV namespace for preview
echo -e "\n${YELLOW}[4/7] Creating KV namespace (preview)...${NC}"
PREVIEW_OUTPUT=$(wrangler kv namespace create PAGE_STATS --preview 2>&1)
echo "$PREVIEW_OUTPUT"

if echo "$PREVIEW_OUTPUT" | grep -q "already exists"; then
    echo -e "${YELLOW}! Preview namespace already exists, using production ID${NC}"
    PREVIEW_ID="$KV_ID"
else
    PREVIEW_ID=$(echo "$PREVIEW_OUTPUT" | grep -oP 'preview_id = "\K[^"]+' || echo "$KV_ID")
fi
echo -e "${GREEN}OK Preview KV ID: ${PREVIEW_ID}${NC}"

# Update wrangler.toml
echo -e "\n${YELLOW}[5/7] Updating wrangler.toml...${NC}"
if [ ! -f "wrangler.toml" ]; then
    echo -e "${RED}XX wrangler.toml not found!${NC}"
    exit 1
fi

# Backup original
cp wrangler.toml wrangler.toml.backup

# Update KV IDs using sed (cross-platform compatible)
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "s/id = \".*\" # KV namespace ID/id = \"$KV_ID\" # KV namespace ID/" wrangler.toml || \
    sed -i '' "s/id = \".*\"/id = \"$KV_ID\"/" wrangler.toml
    sed -i '' "s/preview_id = \".*\"/preview_id = \"$PREVIEW_ID\"/" wrangler.toml
else
    # Linux
    sed -i "s/id = \".*\" # KV namespace ID/id = \"$KV_ID\" # KV namespace ID/" wrangler.toml || \
    sed -i "s/id = \".*\"/id = \"$KV_ID\"/" wrangler.toml
    sed -i "s/preview_id = \".*\"/preview_id = \"$PREVIEW_ID\"/" wrangler.toml
fi

echo -e "${GREEN}OK wrangler.toml updated${NC}"

# Ask about D1 setup
echo -e "\n${YELLOW}[6/7] Optional: D1 Database for Top Posts${NC}"
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
echo -e "\n${YELLOW}[7/7] Deploying to Cloudflare...${NC}"
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
