---
name: mkq-ai-project-status
description: Complete project status, all work done, credentials, servers, pending tasks — full session dump
metadata:
  type: project
  updated: 2026-07-05
---

# MKQ AI — Project Status (PNP)

## 👤 Owner
- **Name:** محمد خالد قطناني (Mohammed Khaled Qatanani / MKQ)
- **Age:** 17
- **GitHub:** github.com/mkjq/mkq-project
- **Domain:** mkq.one (ai.mkq.one for AI interface)
- **Cloudflare email:** Hakareo11@gmail.com

---

## 🖥️ Oracle Cloud VPS
- **IP:** 84.8.122.121
- **Region:** me-riyadh-1 (الرياض)
- **OS:** Ubuntu 24.04 ARM64
- **Shape:** VM.Standard.A1.Flex (4 OCPUs, 24 GB RAM)
- **SSH:** ssh -i ~/.ssh/mkq-oracle.key ubuntu@84.8.122.121
- **SSH Key:** Saved at ~/.ssh/mkq-oracle.key on Windows machine
- ⚠️ **IMPORTANT:** SSH private key was exposed in chat. Must rotate key.

---

## 🧠 MKQ AI Proxy (Custom Python — replaces LiteLLM)
- **Script:** ~/mkq-project/scripts/mkq-proxy.py
- **Port:** 4000
- **Master Key:** sk-mkq-master-secret
- **Client Key:** sk-mkq-ce89133f15d9f9982edeeab3499abf43bb76363349 (also sk-mkq-e5ab7f8c3f5a8cff4abec84be89275d38a1a057525, sk-mkq-278b939fff1d1c05ad8460d7c915c0debe2e21482b)
- **Keys File:** /var/lib/mkq/keys.json
- **Log File:** ~/mkq-proxy.log
- **Models:** deepseek-r1-mkq, deepseek-r1:8b

### Commands:
```bash
# Start proxy
nohup python3 ~/mkq-project/scripts/mkq-proxy.py --port 4000 --host 0.0.0.0 > ~/mkq-proxy.log 2>&1 &

# Generate key
curl -s -X POST http://127.0.0.1:4000/key/generate \
  -H "Authorization: Bearer sk-mkq-master-secret" \
  -H "Content-Type: application/json" \
  -d '{"key_alias":"NAME","models":["deepseek-r1-mkq"],"duration":"365d"}'

# Health check
curl http://127.0.0.1:4000/health

# Test chat
curl -s http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer sk-mkq-ce89133f15d9f9982edeeab3499abf43bb76363349" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-r1-mkq","messages":[{"role":"user","content":"قل مرحبا"}],"max_tokens":200}'
```

---

## 🌐 Nginx Configuration
- **Config:** /etc/nginx/sites-available/mkq-frontend
- **Port 80:** Serves frontend from /home/ubuntu/mkq-project/frontend/
- **Port 80 /v1/*:** Proxies to http://127.0.0.1:4000
- **Port 443:** Self-signed SSL → proxy to 127.0.0.1:4000 (config at /etc/nginx/sites-available/mkq-api)

---

## 🔥 Firewall Status
### Oracle Cloud Security List (mkqq → Default Security List):
- ✅ Port 22 (SSH)
- ✅ Port 4000 (MKQ API)

### iptables (inside VPS):
- ✅ Port 22, 80, 443, 4000 are ACCEPT

---

## 🎨 Frontend (Premium Interface)
- **File:** frontend/index.html — 1404 lines, 64KB
- **Design:** Glassmorphism 2.0 + ambient particles + neon accents
- **Features Built:**
  - Multi-model: deepseek-v4-pro, v4-flash, MKQ Custom, R1 8B
  - Reasoning effort: Max / High / None
  - File upload: PDF, Word, Excel, images, code (drag-drop + paste)
  - Voice input (Web Speech API)
  - Chat history (localStorage)
  - Export conversations (Markdown)
  - Copy message, copy code, regenerate
  - Settings panel: System prompt, Temperature, Max Tokens, Theme
  - Keyboard shortcuts: Ctrl+N, Ctrl+, Escape
  - Responsive mobile
- **Config hardcoded:** apiBase='', apiKey='sk-mkq-ce89133f15d9f9982edeeab3499abf43bb76363349', model='deepseek-r1-mkq'
- **Relative API URL** — works when served from same origin via nginx

---

## ☁️ Cloudflare
- **Project:** mkq-ai (Worker with static assets)
- **Type:** Connected via GitHub (auto-deploy on push)
- **Auto-deploy:** Enabled (watches main branch)
- **Domain:** ai.mkq.one (custom domain pending setup)
- **⚠️ ISSUE:** Deployed as Worker, not Pages. Workers can't have env vars. Values hardcoded in HTML as workaround.
- **⚠️ ISSUE:** HTTPS frontend + HTTP API = mixed content blocked. Solutions pending.

---

## 📦 GitHub Repo
- **URL:** https://github.com/mkjq/mkq-project
- **Branch:** main
- **Key Files Created/Modified:**
  - scripts/mkq-proxy.py (custom API proxy — replaces LiteLLM)
  - scripts/verify-connection.sh (connection tester)
  - frontend/wrangler.toml (Cloudflare config)
  - frontend/_headers (security headers)
  - frontend/index.html (premium interface — MAJOR REWRITE)
  - All docs/ rebranded DeepSeek → MKQ AI
  - All scripts/ comments and system prompts updated
  - Unrestricted AI system prompt (no censorship)
  - Model params: num_ctx=8192, num_predict=4096

---

## ⚠️ PENDING / TODO

### Critical:
1. **Open Oracle Cloud ports 80 and 443** — user got "Invalid input" error
2. **Fix Cloudflare Pages mixed content** — HTTPS site can't call HTTP API
3. **Rotate SSH key** — private key was exposed in chat

### Important:
4. Set up ai.mkq.one custom domain on Cloudflare
5. Convert Cloudflare Worker → Pages (or set up Cloudflare Tunnel)
6. Test frontend end-to-end with real chat
7. Create systemd service for mkq-proxy.py (auto-start on reboot)

### Nice to Have:
8. Let's Encrypt SSL instead of self-signed
9. Cloudflare Tunnel for secure connection without open ports
10. Multi-user support
11. Usage tracking dashboard

---

## 🔑 Credentials Summary
```
VPS IP:        84.8.122.121
SSH User:      ubuntu
SSH Key Path:  ~/.ssh/mkq-oracle.key
Master Key:    sk-mkq-master-secret
Client Key:    sk-mkq-ce89133f15d9f9982edeeab3499abf43bb76363349
Model:         deepseek-r1-mkq
API Port:      4000
Web Port:      80 (nginx)
```

---

## 📋 How to Resume
1. SSH: `ssh -i ~/.ssh/mkq-oracle.key ubuntu@84.8.122.121`
2. Check proxy: `curl http://127.0.0.1:4000/health`
3. If down: `nohup python3 ~/mkq-project/scripts/mkq-proxy.py --port 4000 --host 0.0.0.0 > ~/mkq-proxy.log 2>&1 &`
4. Test: `curl -s http://84.8.122.121:4000/v1/chat/completions -H "Authorization: Bearer sk-mkq-ce89133f15d9f9982edeeab3499abf43bb76363349" -H "Content-Type: application/json" -d '{"model":"deepseek-r1-mkq","messages":[{"role":"user","content":"مرحبا"}],"max_tokens":200}'`

---

## 🎯 The Big Picture
MKQ AI is a **free, unrestricted AI assistant** — no censorship, no limits, free-thinking. Runs on Oracle Cloud Free VPS with a custom Python proxy (replacing LiteLLM). Premium glassmorphism frontend with 25+ features. System prompt in Arabic emphasizing intellectual freedom across all domains including cybersecurity.

**Brand:** MKQ AI (formerly DeepSeek-R1)
**Nicknames:** MAQTANANY, مقطناني, MKQ
**Domain plan:** ai.mkq.one (subdomain of mkq.one)
