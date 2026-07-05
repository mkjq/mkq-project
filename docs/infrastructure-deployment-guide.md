# MKQ AI R1 Cloud Infrastructure — Deployment Guide

A production-grade guide for self-hosting MKQ AI R1 on Oracle Cloud Always Free, with LiteLLM API proxy, custom `sk-mkq-` API key management, and Cloudflare Pages frontend integration.

## Architecture

```
┌─────────────────────────────────┐      ┌──────────────────────────────────────┐
│   Cloudflare Pages (Frontend)   │      │    Oracle Cloud ARM VPS (Backend)     │
│                                 │      │                                      │
│  ┌───────────────────────────┐  │      │  ┌────────┐    ┌──────┐    ┌───────┐ │
│  │ streaming-client.js       │  │ HTTPS│  │ Nginx  │───▶│LiteLLM│───▶│Ollama │ │
│  │ (fetch + ReadableStream)  │──┼──────┼─▶│ :443   │    │ :4000 │    │:11434 │ │
│  │ Authorization: Bearer     │  │      │  │ (SSL)  │◀───│(proxy)│◀───│(model)│ │
│  │   sk-mkq-xxxx...          │  │      │  └────────┘    └──────┘    └───────┘ │
│  └───────────────────────────┘  │      │                                      │
└─────────────────────────────────┘      └──────────────────────────────────────┘
```

## Quick Start

### 1. Provision Oracle Cloud VPS

1. Create an [Oracle Cloud Always Free account](https://www.oracle.com/cloud/free/)
2. Launch an **Ampere ARM** instance:
   - **OS:** Ubuntu 24.04 LTS
   - **Shape:** VM.Standard.A1.Flex (4 OCPUs, 24 GB RAM)
   - **Boot Volume:** 200 GB NVMe SSD
3. Open ports in the Oracle Cloud Security List: `22`, `80`, `443`
4. SSH into your instance

### 2. Run the Setup Script

```bash
# Download and run the setup script
curl -O https://your-repo/scripts/setup-ollama-litellm.sh
chmod +x setup-ollama-litellm.sh

# Optional: customize model and domain
export DEEPSEEK_MODEL="deepseek-r1:8b"
export DOMAIN_NAME="api.yourdomain.com"
export LITELLM_MASTER_KEY="sk-mkq-master-$(openssl rand -hex 24)"

sudo -E ./setup-ollama-litellm.sh
```

**What this installs:**
- Ollama with MKQ AI R1 (7B or 8B distilled)
- Custom-tuned model via Modelfile (`deepseek-r1-mkq`)
- LiteLLM proxy with OpenAI-compatible API
- Nginx reverse proxy with self-signed SSL
- UFW firewall (ports 22, 80, 443)
- `mkq-keygen` CLI tool for key management

### 3. Generate API Keys

```bash
# Generate a key for a web application
mkq-keygen new my-website --rpm 60 --tpm 30000 --budget 10.0

# List all keys
mkq-keygen list

# View key details
mkq-keygen info my-website

# Rotate (revoke + reissue) a key
mkq-keygen rotate my-website

# Revoke a key
mkq-keygen revoke my-website
```

### 4. Deploy Frontend to Cloudflare Pages

1. Push this repo to GitHub (already done if you're reading this there)
2. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages → Create → Pages
3. Connect your GitHub repo
4. Configure the build:
   - **Framework preset:** None (static HTML)
   - **Build command:** `node frontend/build.js`
   - **Build output directory:** `frontend/dist`
5. Add environment variables in Cloudflare Pages settings:
   - `API_BASE_URL` = `https://YOUR_ORACLE_VPS_IP`
   - `API_KEY` = `sk-mkq-xxxxxxxx...` (generated in step 3)
   - `MODEL` = `deepseek-r1-mkq`
6. Click **Save and Deploy**

The chat UI will be live at `https://your-project.pages.dev` with:
- Real-time streaming responses via SSE
- Reasoning/thinking block display (collapsible)
- Dark theme, mobile-responsive
- Auto-reconnect on errors

## API Key Format

All keys follow the pattern: `sk-mkq-` + 42 hex characters = 48 total

```
sk-mkq-a7b3c9ef12d4567890abcdef1234567890abcdef12
│      │                                              │
│      └─ 42 lowercase hex chars (21 random bytes) ───┘
└─ Branded prefix (enforced by custom LiteLLM callback)
```

## Files

| File | Purpose |
|------|---------|
| `scripts/setup-ollama-litellm.sh` | One-shot server provisioning script |
| `configs/litellm-config.yaml` | LiteLLM proxy configuration reference |
| `configs/custom_key_validator.py` | Python callback enforcing `sk-mkq-` prefix |
| `client/streaming-client.js` | Browser streaming client (ES6+, zero deps) |
| `frontend/index.html` | Cloudflare Pages chat UI (self-contained) |
| `frontend/build.js` | Build script: injects env vars before deploy |
| `frontend/_headers` | Security headers for Cloudflare Pages |

## Service Management

```bash
# Check service status
systemctl status ollama
systemctl status litellm
systemctl status nginx

# View logs
journalctl -u ollama -f
journalctl -u litellm -f

# Restart services
systemctl restart ollama
systemctl restart litellm
```

## Security Notes

- The master key (`sk-mkq-master-...`) has full admin access — store it securely
- Use `certbot --nginx -d your-domain.com` to replace the self-signed SSL cert
- Restrict SSH to trusted IPs in UFW for production
- Rotate client API keys every 30 days (or configure shorter lifetimes)
- Never commit API keys to source — use Cloudflare Pages environment variables
- The custom callback validates key format on every request — non-`sk-mkq-` keys are dropped immediately
