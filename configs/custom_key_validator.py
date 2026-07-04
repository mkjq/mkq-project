"""
Custom LiteLLM Callback: Enforce sk-mkq- Key Prefix
====================================================
Deploy this at /opt/litellm/callbacks/custom_key_validator.py
and reference it in the LiteLLM config under litellm_settings.callbacks.

Behavior:
  - ACCEPT:  sk-mkq-a7b3c9ef12d4...  (correct prefix + 42 hex chars)
  - REJECT:  sk-xxxxxxxx...          (missing mkq- brand prefix)
  - REJECT:  sk-mkq-                 (too short / malformed)
  - REJECT:  bare-string             (no sk- prefix at all)

The KEY_PATTERN regex is the single source of truth for key validation.
"""

import re
from typing import Optional, Dict, Any

# ---------------------------------------------------------------------------
# The enforced key pattern — modify this regex to change the allowed pattern
# Current: sk-mkq- + exactly 42 lowercase hex chars = 48 character total
# ---------------------------------------------------------------------------
KEY_PATTERN = re.compile(r"^sk-mkq-[a-f0-9]{42}$")


async def custom_key_validator(
    request_data: Dict[str, Any],
    user_api_key_dict: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """
    Validate that the API key matches the sk-mkq- pattern.

    Called by LiteLLM on every inbound request before routing.
    Returns None to reject (HTTP 401), or the key dict to accept.
    """
    if user_api_key_dict is None:
        return None  # No key provided -> reject

    token = user_api_key_dict.get("token", "")
    if not token:
        return None

    # Check prefix match against enforced pattern
    if not KEY_PATTERN.match(token):
        # Log rejection (avoid logging full keys in production)
        token_preview = token[:12] + "..." if len(token) > 12 else token[:6]
        print(f"[mkq-guard] REJECTED key with invalid format: {token_preview}")
        return None

    return user_api_key_dict  # Valid -> pass through


# ---------------------------------------------------------------------------
# Static helpers — usable outside the LiteLLM callback lifecycle
# ---------------------------------------------------------------------------

def validate_key_format_static(api_key: str) -> bool:
    """Check if a key string matches the required sk-mkq- format."""
    return bool(KEY_PATTERN.match(api_key))


def generate_mkq_key() -> str:
    """
    Generate a valid sk-mkq- API key.

    Format: sk-mkq- + 42 lowercase hex characters = 48 chars total.
    Uses secrets.token_hex for cryptographically secure randomness.

    Example output: sk-mkq-a7b3c9ef12d4567890abcdef1234567890abcdef12

    Returns:
        str: A compliant API key.
    """
    import secrets
    hex_part = secrets.token_hex(21)  # 21 bytes = 42 hex chars
    return f"sk-mkq-{hex_part}"


# ---------------------------------------------------------------------------
# LiteLLM callback registration entry point
# ---------------------------------------------------------------------------
def get_custom_callbacks():
    """Return dict of callbacks for LiteLLM registration."""
    return {
        "async_pre_call_hooks": [custom_key_validator],
    }


# ---------------------------------------------------------------------------
# Quick self-test (run: python3 custom_key_validator.py)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("=== mkq-key-validator: Self-Test ===\n")

    test_keys = [
        ("sk-mkq-a7b3c9ef12d4567890abcdef1234567890abcdef12", True),
        ("sk-mkq-1a2b3c4d5e6f7890abcdef1234567890abcdef1234", True),
        ("sk-mkq-000000000000000000000000000000000000000000", True),
        ("sk-a7b3c9ef12d4567890abcdef1234567890abcdef12", False),   # missing mkq-
        ("sk-mkq-short", False),                                      # too short
        ("sk-mkq-ABCDEF1234567890abcdef1234567890abcdef12", False),  # uppercase
        ("sk-mkq-a7b3c9ef12d4567890abcdef1234567890abcdef123", False), # too long
        ("bare-string-no-prefix", False),
        ("", False),
    ]

    for key, expected in test_keys:
        result = validate_key_format_static(key)
        status = "PASS" if result == expected else "FAIL"
        marker = "[PASS]" if result == expected else "[FAIL]"
        print(f"  {marker} {status}: '{key[:30]}{'...' if len(key) > 30 else ''}' -> valid={result} (expected={expected})")

    print("\n=== Generated test key ===")
    print(f"  {generate_mkq_key()}")
    print(f"\nAll tests complete.")
