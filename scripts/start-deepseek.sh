#!/usr/bin/env bash
# ==============================================================================
# start-deepseek.sh — Run MKQ AI as a background service (local/dev mode)
# ==============================================================================
# Usage:
#   ./start-deepseek.sh              # Start all services in background
#   ./start-deepseek.sh --stop       # Stop all services
#   ./start-deepseek.sh --status     # Check what's running
#
# This script runs Ollama + the key validator as a background process on
# a local machine (Linux/macOS/WSL). For production Oracle Cloud deployment,
# use scripts/setup-ollama-litellm.sh instead — that script installs proper
# systemd services that survive reboots.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PID_DIR="${PROJECT_ROOT}/.pids"
LOG_DIR="${PROJECT_ROOT}/logs"

mkdir -p "${PID_DIR}" "${LOG_DIR}"

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

# ---------------------------------------------------------------------------
# Start Ollama in background
# ---------------------------------------------------------------------------
start_ollama() {
    if pgrep -f "ollama serve" > /dev/null 2>&1; then
        echo -e "${YELLOW}[!]${NC} Ollama is already running."
        return 0
    fi

    echo -n "Starting Ollama..."
    ollama serve > "${LOG_DIR}/ollama.log" 2>&1 &
    echo $! > "${PID_DIR}/ollama.pid"
    sleep 2

    if pgrep -f "ollama serve" > /dev/null 2>&1; then
        echo -e " ${GREEN}OK${NC} (PID: $(cat ${PID_DIR}/ollama.pid))"
    else
        echo -e " ${RED}FAILED${NC} — check ${LOG_DIR}/ollama.log"
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Pull model if not present, then preload it
# ---------------------------------------------------------------------------
ensure_model() {
    local model="${1:-deepseek-r1:8b}"

    if ollama list 2>/dev/null | grep -q "${model}"; then
        echo -e "${GREEN}[✓]${NC} Model '${model}' already present."
        return 0
    fi

    echo "Pulling model '${model}' (this may take 5-15 minutes on first run)..."
    ollama pull "${model}"
    echo -e "${GREEN}[✓]${NC} Model '${model}' pulled."
}

# ---------------------------------------------------------------------------
# Preload model into memory (keeps it warm)
# ---------------------------------------------------------------------------
preload_model() {
    local model="${1:-deepseek-r1:8b}"
    echo -n "Preloading model into memory..."
    ollama run "${model}" "" > /dev/null 2>&1 &
    echo -e " ${GREEN}done${NC}"
}

# ---------------------------------------------------------------------------
# Start key validator as a simple health-check HTTP server
# ---------------------------------------------------------------------------
start_validator() {
    if pgrep -f "custom_key_validator.py" > /dev/null 2>&1; then
        echo -e "${YELLOW}[!]${NC} Key validator is already running."
        return 0
    fi

    echo -n "Starting key validator..."
    python3 "${PROJECT_ROOT}/configs/custom_key_validator.py" \
        > "${LOG_DIR}/validator.log" 2>&1 &
    echo $! > "${PID_DIR}/validator.pid"
    sleep 1

    if pgrep -f "custom_key_validator.py" > /dev/null 2>&1; then
        echo -e " ${GREEN}OK${NC} (PID: $(cat ${PID_DIR}/validator.pid))"
    else
        echo -e " ${RED}FAILED${NC} — check ${LOG_DIR}/validator.log"
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Stop all services
# ---------------------------------------------------------------------------
stop_all() {
    echo "Stopping services..."

    for svc in ollama validator; do
        local pid_file="${PID_DIR}/${svc}.pid"
        if [[ -f "${pid_file}" ]]; then
            local pid=$(cat "${pid_file}")
            if kill -0 "${pid}" 2>/dev/null; then
                kill "${pid}" 2>/dev/null || true
                echo -e "  ${GREEN}[✓]${NC} Stopped ${svc} (PID: ${pid})"
            fi
            rm -f "${pid_file}"
        fi
    done

    # Clean up any lingering processes
    pkill -f "custom_key_validator.py" 2>/dev/null || true
    echo "All services stopped."
}

# ---------------------------------------------------------------------------
# Show status
# ---------------------------------------------------------------------------
show_status() {
    echo "Service Status:"
    echo "───────────────"

    if pgrep -f "ollama serve" > /dev/null 2>&1; then
        echo -e "  Ollama:         ${GREEN}RUNNING${NC}"
    else
        echo -e "  Ollama:         ${RED}STOPPED${NC}"
    fi

    if pgrep -f "custom_key_validator.py" > /dev/null 2>&1; then
        echo -e "  Key Validator:  ${GREEN}RUNNING${NC}"
    else
        echo -e "  Key Validator:  ${RED}STOPPED${NC}"
    fi

    echo ""
    echo "Installed models:"
    ollama list 2>/dev/null || echo "  (Ollama not running — can't list models)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
MODEL="${DEEPSEEK_MODEL:-deepseek-r1:8b}"

case "${1:-}" in
    --stop)
        stop_all
        exit 0
        ;;
    --status)
        show_status
        exit 0
        ;;
    --help|-h)
        echo "Usage: $0 [--stop|--status|--help]"
        echo ""
        echo "  (no args)   Start all services in background"
        echo "  --stop      Stop all running services"
        echo "  --status    Show what's running"
        echo ""
        echo "Model can be set via DEEPSEEK_MODEL env var (default: deepseek-r1:8b)"
        exit 0
        ;;
esac

# Check prerequisites
if ! command -v ollama &> /dev/null; then
    echo -e "${RED}[✗]${NC} Ollama is not installed. Install it first:"
    echo "    curl -fsSL https://ollama.com/install.sh | sh"
    exit 1
fi

if ! command -v python3 &> /dev/null; then
    echo -e "${RED}[✗]${NC} Python 3 is not installed."
    exit 1
fi

echo "═══════════════════════════════════════════"
echo "  MKQ AI Background Service Launcher"
echo "  Model: ${MODEL}"
echo "═══════════════════════════════════════════"
echo ""

start_ollama
ensure_model "${MODEL}"
preload_model "${MODEL}"
start_validator

echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  All services running in background${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo "  Ollama:          http://127.0.0.1:11434"
echo "  Logs:            ${LOG_DIR}/"
echo ""
echo "  Stop services:   $0 --stop"
echo "  Check status:    $0 --status"
echo ""

# Keep running until Ctrl+C, then clean up
trap 'echo ""; stop_all; exit 0' INT TERM
echo "Press Ctrl+C to stop all services."
while true; do sleep 1; done
