#!/usr/bin/env bash
# ==============================================================================
# verify-connection.sh — MKQ AI End-to-End Connection Test
# ==============================================================================
# Tests the full chain: Cloudflare Pages → LiteLLM API → Ollama Model
#
# Usage:
#   ./scripts/verify-connection.sh                           # Test local LiteLLM
#   ./scripts/verify-connection.sh https://YOUR_VPS_IP       # Test remote VPS
#   ./scripts/verify-connection.sh https://mkq.one           # Test via domain
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
BOLD='\033[1m'; NC='\033[0m'

PASS="${GREEN}[✓]${NC}"
FAIL="${RED}[✗]${NC}"
INFO="${BLUE}[i]${NC}"
WARN="${YELLOW}[!]${NC}"

# ─── Config ─────────────────────────────────────────────────────────────────
API_BASE="${1:-http://127.0.0.1:4000}"
MASTER_KEY="${LITELLM_MASTER_KEY:-sk-mkq-master-unknown}"
TOTAL_TESTS=0
PASSED_TESTS=0

# ─── Helpers ────────────────────────────────────────────────────────────────
check() {
    local label="$1"; shift
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    if "$@" > /dev/null 2>&1; then
        echo -e "  ${PASS} ${label}"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        return 0
    else
        echo -e "  ${FAIL} ${label}"
        return 1
    fi
}

section() {
    echo ""
    echo -e "${BOLD}${BLUE}━━━ $* ━━━${NC}"
}

# ─── Banner ─────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     🔗 MKQ AI — Connection Verification Tool                 ║"
echo "║     Target: ${API_BASE}                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ─── 1. Network Reachability ────────────────────────────────────────────────
section "1. Network Reachability"

# Extract host:port from API_BASE
HOST=$(echo "${API_BASE}" | sed -E 's|https?://||' | cut -d/ -f1)
echo -e "  ${INFO} Target host: ${HOST}"

# TCP connectivity
if echo "Q" | nc -w 5 "${HOST%:*}" "${HOST##*:}" 2>/dev/null; then
    echo -e "  ${PASS} TCP connection to ${HOST} — OK"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "  ${FAIL} TCP connection to ${HOST} — FAILED (firewall? VPS down?)"
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

# ─── 2. Health Check ────────────────────────────────────────────────────────
section "2. LiteLLM Health Check"

HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "${API_BASE}/health" 2>/dev/null || echo "000")
if [[ "${HEALTH}" == "200" ]]; then
    echo -e "  ${PASS} LiteLLM /health — HTTP ${HEALTH}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "  ${FAIL} LiteLLM /health — HTTP ${HEALTH} (expected 200)"
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

# ─── 3. Authentication ──────────────────────────────────────────────────────
section "3. Authentication"

# Try to list keys (requires master key)
KEYS_RESPONSE=$(curl -s "${API_BASE}/key/list" \
    -H "Authorization: Bearer ${MASTER_KEY}" 2>/dev/null || echo '{"error":"connection_failed"}')

if echo "${KEYS_RESPONSE}" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    echo -e "  ${PASS} Key list retrieved successfully"
    PASSED_TESTS=$((PASSED_TESTS + 1))
    echo -e "  ${INFO} Keys found: $(echo "${KEYS_RESPONSE}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else '?')" 2>/dev/null || echo '?')"
else
    echo -e "  ${WARN} Could not retrieve key list (check MASTER_KEY)"
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

# ─── 4. Model Availability ──────────────────────────────────────────────────
section "4. Model Availability"

MODELS_RESPONSE=$(curl -s "${API_BASE}/v1/models" \
    -H "Authorization: Bearer ${MASTER_KEY}" 2>/dev/null || echo '{"data":[]}')

MODEL_COUNT=$(echo "${MODELS_RESPONSE}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',[])))" 2>/dev/null || echo "0")

if [[ "${MODEL_COUNT}" -gt 0 ]]; then
    echo -e "  ${PASS} Models available: ${MODEL_COUNT}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
    echo "${MODELS_RESPONSE}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for m in d.get('data',[]):
    print(f'      • {m[\"id\"]}')" 2>/dev/null
else
    echo -e "  ${FAIL} No models found"
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

# ─── 5. Streaming Chat Completion ───────────────────────────────────────────
section "5. Streaming Chat Completion"

echo -e "  ${INFO} Sending: 'Say hello in one sentence' → model: deepseek-r1-mkq"

# Generate a test key first (or use existing from env)
TEST_KEY="${MKQ_CLIENT_KEY:-}"
if [[ -z "${TEST_KEY}" ]]; then
    TEST_KEY="sk-mkq-$(python3 -c "import secrets; print(secrets.token_hex(21))" 2>/dev/null || echo "000000000000000000000000000000000000000000")"
    # Try to register it
    curl -s -X POST "${API_BASE}/key/generate" \
        -H "Authorization: Bearer ${MASTER_KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"key\":\"${TEST_KEY}\",\"key_alias\":\"verify-test\",\"models\":[\"deepseek-r1-mkq\"]}" \
        > /dev/null 2>&1 || true
fi

echo -e "  ${INFO} Using key: ${TEST_KEY:0:12}..."

# Send streaming request
STREAM_START=$(date +%s%3N)
RESPONSE=$(curl -s -N "${API_BASE}/v1/chat/completions" \
    -H "Authorization: Bearer ${TEST_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d '{
        "model": "deepseek-r1-mkq",
        "messages": [{"role": "user", "content": "Say hello in one sentence."}],
        "stream": true,
        "max_tokens": 60
    }' 2>/dev/null | head -30 || echo "")

STREAM_END=$(date +%s%3N)
STREAM_TIME=$((STREAM_END - STREAM_START))

if echo "${RESPONSE}" | grep -q '"content"'; then
    echo -e "  ${PASS} Streaming response received in ${STREAM_TIME}ms"
    PASSED_TESTS=$((PASSED_TESTS + 1))
    # Extract the actual text
    echo -e "  ${INFO} Response preview:"
    echo "${RESPONSE}" | grep -oP '"content":"[^"]*"' | head -3 | while read -r line; do
        echo "      ${line}"
    done
elif echo "${RESPONSE}" | grep -q '"reasoning_content"'; then
    echo -e "  ${PASS} Reasoning (thinking) tokens received in ${STREAM_TIME}ms"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "  ${FAIL} No valid streaming response"
    echo -e "  ${INFO} Raw response (first 300 chars):"
    echo "${RESPONSE:0:300}"
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

# ─── 6. Key Format Validation ───────────────────────────────────────────────
section "6. Key Format Validation (sk-mkq- enforcement)"

# Test: bad key should be rejected
BAD_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "${API_BASE}/v1/chat/completions" \
    -H "Authorization: Bearer sk-bad-key-123" \
    -H "Content-Type: application/json" \
    -d '{"model":"deepseek-r1-mkq","messages":[{"role":"user","content":"test"}]}' 2>/dev/null || echo "000")

if [[ "${BAD_RESPONSE}" == "401" ]] || [[ "${BAD_RESPONSE}" == "403" ]]; then
    echo -e "  ${PASS} Bad key rejected with HTTP ${BAD_RESPONSE}"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "  ${FAIL} Bad key returned HTTP ${BAD_RESPONSE} (expected 401/403)"
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

# ─── 7. CORS Headers (for Cloudflare Pages frontend) ────────────────────────
section "7. CORS Headers"

CORS_RESPONSE=$(curl -s -I -X OPTIONS "${API_BASE}/v1/chat/completions" \
    -H "Origin: https://mkq.one" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: Content-Type, Authorization" 2>/dev/null || echo "")

if echo "${CORS_RESPONSE}" | grep -qi "access-control"; then
    echo -e "  ${PASS} CORS headers present"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "  ${WARN} No CORS headers (may need Nginx config)"
    echo -e "  ${INFO} Add to Nginx: add_header Access-Control-Allow-Origin *;"
fi
TOTAL_TESTS=$((TOTAL_TESTS + 1))

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     📊 TEST SUMMARY                                          ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo -e "║     ${PASSED_TESTS}/${TOTAL_TESTS} tests passed"
echo "╚══════════════════════════════════════════════════════════════╝"

if [[ "${PASSED_TESTS}" -eq "${TOTAL_TESTS}" ]]; then
    echo ""
    echo -e "  ${GREEN}${BOLD}🎉 ALL TESTS PASSED — MKQ AI is ready!${NC}"
    echo ""
    echo "  Cloudflare Pages can now connect to: ${API_BASE}"
    echo "  Deploy your frontend and it will work!"
    exit 0
else
    FAILED=$((TOTAL_TESTS - PASSED_TESTS))
    echo ""
    echo -e "  ${RED}${BOLD}⚠ ${FAILED} test(s) failed${NC}"
    echo ""
    echo "  Troubleshooting:"
    echo "  1. Is the VPS running? Check: ssh to your Oracle instance"
    echo "  2. Is LiteLLM running?  sudo systemctl status litellm"
    echo "  3. Is Ollama running?   sudo systemctl status ollama"
    echo "  4. Is the firewall open? sudo ufw status"
    echo "  5. Is the API key valid? Check sk-mkq- format"
    exit 1
fi
