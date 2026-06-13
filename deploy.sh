#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════
#  Gobi Replica v2 — One-Command Fly.io Deploy
#  Usage:  chmod +x deploy.sh && ./deploy.sh
# ═══════════════════════════════════════════════════════════════

APP_NAME="${FLY_APP_NAME:-gobi-replica}"
REGION="${FLY_REGION:-iad}"
VOLUME_SIZE="${FLY_VOLUME_SIZE:-1}"

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERR]${NC}   $*"; }

# ── Prerequisites Check ──────────────────────────────────────
info "Checking prerequisites..."

if ! command -v fly &>/dev/null; then
  err "fly CLI not found. Install: curl -L https://fly.io/install.sh | sh"
  exit 1
fi
ok "fly CLI $(fly version 2>/dev/null | head -1 || echo 'installed')"

if ! command -v node &>/dev/null; then
  err "Node.js not found. Install Node >=20 from https://nodejs.org"
  exit 1
fi
ok "Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
  err "npm not found."
  exit 1
fi
ok "npm $(npm --version)"

# ── Auth Check ───────────────────────────────────────────────
info "Checking Fly.io authentication..."
if ! fly auth whoami &>/dev/null; then
  warn "Not logged in. Run: fly auth login"
  fly auth login
fi
ok "Authenticated as $(fly auth whoami 2>/dev/null || echo 'fly.io user')"

# ── Install Dependencies ─────────────────────────────────────
info "Installing npm dependencies..."
npm ci --omit=dev 2>&1 | tail -1
ok "Dependencies installed"

# ── Validate Build ───────────────────────────────────────────
info "Validating project structure..."
if [ ! -f "src/index.js" ]; then
  err "Missing src/index.js — not in project root?"
  exit 1
fi
if [ ! -f "Dockerfile" ]; then
  err "Missing Dockerfile"
  exit 1
fi
if [ ! -f "fly.toml" ]; then
  err "Missing fly.toml"
  exit 1
fi
ok "Project structure valid"

# ── Secrets Setup ────────────────────────────────────────────
info "Checking for .env secrets to migrate..."
REQUIRED_SECRETS=()
if [ -f ".env" ]; then
  # Source .env safely
  set -a; source .env; set +a

  [ -n "${OPENROUTER_API_KEY:-}" ] && REQUIRED_SECRETS+=("OPENROUTER_API_KEY=$OPENROUTER_API_KEY")
  [ -n "${OPENAI_API_KEY:-}" ]    && REQUIRED_SECRETS+=("OPENAI_API_KEY=$OPENAI_API_KEY")
  [ -n "${TWILIO_ACCOUNT_SID:-}" ] && REQUIRED_SECRETS+=("TWILIO_ACCOUNT_SID=$TWILIO_ACCOUNT_SID")
  [ -n "${TWILIO_AUTH_TOKEN:-}" ]  && REQUIRED_SECRETS+=("TWILIO_AUTH_TOKEN=$TWILIO_AUTH_TOKEN")
  [ -n "${TWILIO_FROM_NUMBER:-}" ] && REQUIRED_SECRETS+=("TWILIO_FROM_NUMBER=$TWILIO_FROM_NUMBER")
  [ -n "${SMTP_USER:-}" ]          && REQUIRED_SECRETS+=("SMTP_USER=$SMTP_USER")
  [ -n "${SMTP_PASS:-}" ]          && REQUIRED_SECRETS+=("SMTP_PASS=$SMTP_PASS")

  if [ ${#REQUIRED_SECRETS[@]} -gt 0 ]; then
    info "Setting ${#REQUIRED_SECRETS[@]} secrets on Fly.io..."
    fly secrets set "${REQUIRED_SECRETS[@]}" --app "$APP_NAME" 2>/dev/null || warn "Some secrets may already exist (ok)"
  fi
fi

# Generate session secret if not set
if [ -z "${SESSION_SECRET:-}" ]; then
  SESSION_SECRET=$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  fly secrets set "SESSION_SECRET=$SESSION_SECRET" --app "$APP_NAME" 2>/dev/null || warn "SESSION_SECRET may already exist"
fi

# Prompt for OpenRouter key if not set anywhere
EXISTING_SECRETS=$(fly secrets list --app "$APP_NAME" 2>/dev/null || echo "")
if ! echo "$EXISTING_SECRETS" | grep -q "OPENROUTER_API_KEY" && [ -z "${OPENROUTER_API_KEY:-}" ]; then
  warn "No OpenRouter API key found."
  echo -e "${CYAN}Get a free key at https://openrouter.ai/keys (no credit card)${NC}"
  read -rp "Enter your OpenRouter API key (or press Enter to skip): " OPENROUTER_KEY
  if [ -n "$OPENROUTER_KEY" ]; then
    fly secrets set "OPENROUTER_API_KEY=$OPENROUTER_KEY" --app "$APP_NAME"
  fi
fi
ok "Secrets configured"

# ── Launch or Reuse App ──────────────────────────────────────
info "Checking Fly.io app '$APP_NAME'..."
if fly apps list 2>/dev/null | grep -q "$APP_NAME"; then
  ok "App '$APP_NAME' already exists — reusing"
else
  info "Creating app '$APP_NAME'..."
  fly apps create "$APP_NAME" --org personal 2>/dev/null || fly apps create "$APP_NAME"
  ok "App '$APP_NAME' created"
fi

# ── Persistent Volume ────────────────────────────────────────
info "Checking for persistent volume..."
if fly volumes list --app "$APP_NAME" 2>/dev/null | grep -q "data"; then
  ok "Volume 'data' already exists"
else
  info "Creating ${VOLUME_SIZE}GB volume in $REGION..."
  fly volumes create data --region "$REGION" --size "$VOLUME_SIZE" --app "$APP_NAME"
  ok "Volume created"
fi

# ── Allocate IP (first deploy) ───────────────────────────────
if ! fly ips list --app "$APP_NAME" 2>/dev/null | grep -q "v4"; then
  info "Allocating IPv4..."
  fly ips allocate-v4 --app "$APP_NAME" --shared 2>/dev/null || warn "IPv4 may already exist"
fi

# ── Deploy ───────────────────────────────────────────────────
info "Deploying to Fly.io (region: $REGION, size: shared-cpu-1x 256MB)..."
fly deploy --app "$APP_NAME" --remote-only

ok "Deploy complete!"

# ── Post-Deploy Info ─────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✅  Gobi Replica v2 is LIVE!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  App URL:    ${CYAN}https://${APP_NAME}.fly.dev${NC}"
echo -e "  Chat API:   ${CYAN}https://${APP_NAME}.fly.dev/api/chat${NC}"
echo -e "  Health:     ${CYAN}https://${APP_NAME}.fly.dev/health${NC}"
echo -e "  SMS Webhook:${CYAN}https://${APP_NAME}.fly.dev/api/sms/webhook${NC}"
echo ""
echo -e "  ${YELLOW}Quick commands:${NC}"
echo -e "    fly logs -a ${APP_NAME}           # View logs"
echo -e "    fly open -a ${APP_NAME}           # Open in browser"
echo -e "    fly status -a ${APP_NAME}         # Check status"
echo -e "    fly ssh console -a ${APP_NAME}    # SSH into VM"
echo ""