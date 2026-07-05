/**
 * =============================================================================
 * MKQ AI Streaming Client — Cloudflare Pages Frontend
 * =============================================================================
 *
 * A robust, production-ready JavaScript module for streaming chat completions
 * from a self-hosted MKQ AI inference server (Oracle Cloud VPS + LiteLLM).
 *
 * Features:
 *   - Custom sk-mkq- API key authentication
 *   - Server-Sent Events (SSE) streaming via ReadableStream
 *   - Automatic reconnection with exponential backoff
 *   - AbortController support for cancellation
 *   - Full error handling & rate-limit detection
 *   - Tiny footprint (zero dependencies)
 *
 * Deployment: Drop into any Cloudflare Pages project. Works with vanilla JS,
 * React, Vue, Svelte, or any framework that runs in the browser.
 *
 * =============================================================================
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  /** Your Oracle VPS public endpoint (Nginx reverse proxy) */
  apiBaseUrl: 'https://YOUR_VPS_IP_OR_DOMAIN',

  /** The model name as registered in LiteLLM config */
  model: 'deepseek-r1-mkq',

  /** Your sk-mkq- API key (in production, inject via Cloudflare env vars) */
  apiKey: 'sk-mkq-YOUR_API_KEY_HERE',

  /** Stream chunk delimiter */
  sseDelimiter: 'data: ',

  /** Max retries for failed connections */
  maxRetries: 3,

  /** Base delay for exponential backoff (ms) */
  retryBaseDelayMs: 1000,
};

// ---------------------------------------------------------------------------
// Validation — Ensure API key matches the required sk-mkq- pattern
// ---------------------------------------------------------------------------

const MKQ_KEY_REGEX = /^sk-mkq-[a-f0-9]{42}$/;

/**
 * Validate that an API key conforms to the sk-mkq- format.
 * @param {string} key - The API key to validate
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateApiKey(key) {
  if (!key || typeof key !== 'string') {
    return { valid: false, reason: 'API key is missing or not a string.' };
  }
  if (!key.startsWith('sk-mkq-')) {
    return {
      valid: false,
      reason: `API key must start with "sk-mkq-". Got: "${key.substring(0, 12)}..."`,
    };
  }
  if (!MKQ_KEY_REGEX.test(key)) {
    return {
      valid: false,
      reason: 'API key format invalid. Expected: sk-mkq- + 42 hex characters.',
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Core Streaming Client
// ---------------------------------------------------------------------------

/**
 * Stream a chat completion from the MKQ AI server.
 *
 * Usage:
 *   const stream = streamChatCompletion({
 *     messages: [{ role: 'user', content: 'Explain quantum computing' }],
 *     onToken: (token) => console.log(token),
 *     onDone: (fullText) => console.log('Done:', fullText),
 *     onError: (err) => console.error(err),
 *   });
 *
 *   // To cancel mid-stream:
 *   stream.abort();
 *
 * @param {Object} options
 * @param {Array<{role: string, content: string}>} options.messages - Chat messages
 * @param {number} [options.temperature=0.7] - Sampling temperature
 * @param {number} [options.maxTokens=2048] - Max tokens to generate
 * @param {function(string): void} [options.onToken] - Called for each token
 * @param {function(string): void} [options.onThinking] - Called with reasoning/thinking tokens
 * @param {function(string): void} [options.onDone] - Called when stream completes
 * @param {function(Error): void} [options.onError] - Called on any error
 * @param {function(Object): void} [options.onMetadata] - Called with usage stats on completion
 * @param {AbortSignal} [options.signal] - External AbortSignal to cancel the request
 * @returns {{ abort: function }} Controller with abort() method
 */
export function streamChatCompletion(options) {
  const {
    messages,
    temperature = 0.7,
    maxTokens = 4096,
    onToken,
    onThinking,
    onDone,
    onError,
    onMetadata,
    signal: externalSignal,
  } = options;

  // ------------------------------------------------------------------
  // Validate API key before making any network request
  // ------------------------------------------------------------------
  const keyValidation = validateApiKey(CONFIG.apiKey);
  if (!keyValidation.valid) {
    const err = new Error(`[mkq-auth] ${keyValidation.reason}`);
    onError?.(err);
    return { abort: () => {} };
  }

  // ------------------------------------------------------------------
  // Set up abort controller (merge external signal with internal)
  // ------------------------------------------------------------------
  const controller = new AbortController();
  if (externalSignal) {
    externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  // ------------------------------------------------------------------
  // Build the request payload (OpenAI-compatible via LiteLLM)
  // ------------------------------------------------------------------
  const payload = {
    model: CONFIG.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
  };

  // ------------------------------------------------------------------
  // Track state
  // ------------------------------------------------------------------
  let fullText = '';
  let thinkingText = '';
  let retryCount = 0;
  let reader = null;

  /**
   * Internal: initiate the fetch and process the stream.
   */
  async function startStream() {
    try {
      const response = await fetch(`${CONFIG.apiBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${CONFIG.apiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      // --- Handle non-200 responses ---------------------------------
      if (!response.ok) {
        const status = response.status;
        let errorBody = '';
        try { errorBody = await response.text(); } catch (_) { /* ignore */ }

        if (status === 401 || status === 403) {
          throw new Error(
            `[mkq-auth] Authentication failed (HTTP ${status}). ` +
            `Verify your sk-mkq- API key is valid and not expired.`
          );
        }
        if (status === 429) {
          throw new Error(
            `[mkq-ratelimit] Rate limit exceeded (HTTP 429). ` +
            `Reduce request frequency or upgrade your key tier.`
          );
        }
        if (status >= 500) {
          throw new Error(
            `[mkq-server] Server error (HTTP ${status}). ` +
            `The inference server may be overloaded. Retrying...`
          );
        }
        throw new Error(`[mkq-api] Unexpected response (HTTP ${status}): ${errorBody}`);
      }

      // --- Verify Content-Type is SSE --------------------------------
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream') && !contentType.includes('application/x-ndjson')) {
        // LiteLLM may return ndjson for streaming; both are handled below
        console.warn(`[mkq-client] Unexpected Content-Type: ${contentType}. Attempting stream parse anyway.`);
      }

      // --- Validate response body exists -----------------------------
      if (!response.body) {
        throw new Error('[mkq-client] Response body is null. Streams not supported in this environment.');
      }

      // --- Read and process the stream -------------------------------
      reader = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(sseParser())
        .getReader();

      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          // Stream finished normally
          onDone?.(fullText, thinkingText);
          return;
        }

        if (value == null) continue;

        // Process each parsed SSE event
        for (const event of value) {
          processStreamEvent(event);
        }
      }
    } catch (err) {
      // Don't handle aborted requests as errors
      if (err.name === 'AbortError') {
        onDone?.(fullText, thinkingText);
        return;
      }

      // Retry on server errors
      if (retryCount < CONFIG.maxRetries && err.message?.includes('[mkq-server]')) {
        retryCount++;
        const delay = CONFIG.retryBaseDelayMs * Math.pow(2, retryCount - 1);
        console.warn(`[mkq-client] Retrying (${retryCount}/${CONFIG.maxRetries}) after ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        return startStream();
      }

      onError?.(err);
    }
  }

  /**
   * Process a single parsed SSE event, dispatching tokens to callbacks.
   */
  function processStreamEvent(event) {
    // LiteLLM sends [DONE] to signal stream end
    if (event === '[DONE]') {
      onDone?.(fullText, thinkingText);
      return;
    }

    try {
      const parsed = typeof event === 'string' ? JSON.parse(event) : event;

      // --- Extract delta content ------------------------------------
      const choices = parsed.choices;
      if (!choices || choices.length === 0) return;

      const delta = choices[0].delta;
      if (!delta) return;

      // MKQ AI returns reasoning_content (thinking) + content (answer)
      if (delta.reasoning_content) {
        thinkingText += delta.reasoning_content;
        onThinking?.(delta.reasoning_content);
      }

      if (delta.content) {
        fullText += delta.content;
        onToken?.(delta.content);
      }

      // --- Emit usage metadata if present (final chunk) -------------
      if (parsed.usage) {
        onMetadata?.({
          promptTokens: parsed.usage.prompt_tokens,
          completionTokens: parsed.usage.completion_tokens,
          totalTokens: parsed.usage.total_tokens,
          model: parsed.model,
        });
      }

      // --- Handle finish reason -------------------------------------
      const finishReason = choices[0].finish_reason;
      if (finishReason && finishReason !== 'null' && finishReason !== null) {
        // Stream is finishing — the next event will be [DONE]
      }
    } catch (_) {
      // If JSON parsing fails, treat the raw event as a token
      // (some backends send plain-text tokens in streaming mode)
      const raw = typeof event === 'string' ? event : '';
      if (raw && raw !== '[DONE]') {
        fullText += raw;
        onToken?.(raw);
      }
    }
  }

  // Kick off the stream
  startStream();

  // Return abort controller
  return {
    abort: () => controller.abort(),
  };
}

// ---------------------------------------------------------------------------
// SSE Parser — TransformStream that parses Server-Sent Events
// ---------------------------------------------------------------------------

/**
 * Creates a TransformStream that converts raw text chunks into parsed
 * SSE event objects. Handles:
 *   - Chunked/split SSE frames across multiple reads
 *   - Empty lines and comments (lines starting with ":")
 *   - Multi-line data fields
 *   - The [DONE] sentinel
 *
 * @returns {TransformStream<string, string[]>}
 */
function sseParser() {
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;

      // Split on double-newline (SSE event boundary)
      const parts = buffer.split('\n\n');
      // The last part may be incomplete — keep it in the buffer
      buffer = parts.pop() || '';

      const events = [];

      for (const part of parts) {
        if (!part.trim()) continue;

        let dataContent = '';

        // Parse each line within the event
        for (const line of part.split('\n')) {
          if (line.startsWith('data: ')) {
            dataContent += line.slice(6);
          } else if (line.startsWith('data:')) {
            dataContent += line.slice(5);
          }
          // Ignore "event:", "id:", "retry:", comments (":"), etc.
        }

        if (dataContent) {
          events.push(dataContent.trim());
        }
      }

      if (events.length > 0) {
        controller.enqueue(events);
      }
    },

    flush(controller) {
      // Process any remaining data in the buffer
      if (buffer.trim()) {
        const lines = buffer.split('\n');
        let dataContent = '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            dataContent += line.slice(6);
          } else if (line.startsWith('data:')) {
            dataContent += line.slice(5);
          }
        }
        if (dataContent.trim()) {
          controller.enqueue([dataContent.trim()]);
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Convenience: Non-streaming chat completion
// ---------------------------------------------------------------------------

/**
 * Send a single chat completion (non-streaming).
 * Returns the full response text.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} [options]
 * @returns {Promise<{content: string, thinking: string, usage: Object}>}
 */
export async function chatCompletion(messages, options = {}) {
  const {
    temperature = 0.7,
    maxTokens = 4096,
    signal,
  } = options;

  const keyValidation = validateApiKey(CONFIG.apiKey);
  if (!keyValidation.valid) {
    throw new Error(`[mkq-auth] ${keyValidation.reason}`);
  }

  const response = await fetch(`${CONFIG.apiBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CONFIG.apiKey}`,
    },
    body: JSON.stringify({
      model: CONFIG.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`[mkq-api] HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0] ?? {};

  return {
    content: choice.message?.content ?? '',
    thinking: choice.message?.reasoning_content ?? '',
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    },
    model: data.model,
  };
}

// ---------------------------------------------------------------------------
// Configuration helper: Update settings at runtime
// ---------------------------------------------------------------------------

/**
 * Update the global client configuration at runtime.
 * Use this to inject API keys from environment variables or user input.
 *
 * @param {Partial<typeof CONFIG>} newConfig
 */
export function configure(newConfig) {
  Object.assign(CONFIG, newConfig);
}

/**
 * Get the current configuration (for debugging).
 * Masks the API key in the output.
 */
export function getConfig() {
  const masked = { ...CONFIG };
  if (masked.apiKey && masked.apiKey.length > 15) {
    masked.apiKey = masked.apiKey.substring(0, 12) + '...' + masked.apiKey.slice(-4);
  }
  return masked;
}

// ---------------------------------------------------------------------------
// Example: HTML/JS Integration (Cloudflare Pages)
// ---------------------------------------------------------------------------

/*
<!-- =========================================================================
  EXAMPLE: Drop this into any Cloudflare Pages index.html
  Replace YOUR_VPS_IP_OR_DOMAIN and YOUR_API_KEY with actual values.
  In production, inject the API key via Cloudflare Pages environment variables,
  never hardcode secrets in source.
  ========================================================================= -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MKQ AI Chat</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 1rem; }
    #chat-box { border: 1px solid #ddd; border-radius: 8px; padding: 1rem; min-height: 400px; max-height: 600px; overflow-y: auto; margin-bottom: 1rem; background: #fafafa; }
    .message { margin-bottom: 1rem; padding: 0.5rem 0; }
    .message.user { color: #333; }
    .message.assistant { color: #1a56db; }
    .message.assistant .thinking { color: #888; font-style: italic; font-size: 0.9em; }
    #input-area { display: flex; gap: 0.5rem; }
    #user-input { flex: 1; padding: 0.75rem; border: 1px solid #ddd; border-radius: 6px; font-size: 1rem; }
    #send-btn { padding: 0.75rem 1.5rem; background: #1a56db; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
    #send-btn:disabled { background: #93c5fd; cursor: not-allowed; }
    #status { font-size: 0.85rem; color: #666; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <h1>🤖 MKQ AI Chat</h1>
  <div id="chat-box"></div>
  <div id="input-area">
    <input id="user-input" type="text" placeholder="Type your message..." autofocus />
    <button id="send-btn">Send</button>
  </div>
  <div id="status">MKQ AI — بلا حدود. Ask anything.</div>

  <script type="module">
    import { streamChatCompletion, configure } from './streaming-client.js';

    // --- CONFIGURE — In production, inject via build-time env vars ---
    configure({
      apiBaseUrl: 'https://YOUR_VPS_IP_OR_DOMAIN',
      apiKey: 'sk-mkq-YOUR_API_KEY_HERE',
      model: 'deepseek-r1-mkq',
    });

    // --- DOM Elements ---
    const chatBox = document.getElementById('chat-box');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const statusEl = document.getElementById('status');

    let isStreaming = false;
    let currentStream = null;

    function appendMessage(role, content, thinking = '') {
      const div = document.createElement('div');
      div.className = `message ${role}`;
      if (thinking) {
        div.innerHTML = `<span class="thinking">💭 ${escapeHtml(thinking)}</span><br>${escapeHtml(content)}`;
      } else {
        div.textContent = content;
      }
      chatBox.appendChild(div);
      chatBox.scrollTop = chatBox.scrollHeight;
    }

    function escapeHtml(str) {
      const el = document.createElement('span');
      el.textContent = str;
      return el.innerHTML;
    }

    async function sendMessage() {
      const text = userInput.value.trim();
      if (!text || isStreaming) return;

      isStreaming = true;
      sendBtn.disabled = true;
      statusEl.textContent = 'Thinking...';

      appendMessage('user', text);
      userInput.value = '';

      // Create a placeholder for the assistant's streaming response
      const assistantDiv = document.createElement('div');
      assistantDiv.className = 'message assistant';
      assistantDiv.id = 'streaming-response';
      chatBox.appendChild(assistantDiv);

      let thinkingBuffer = '';
      let contentBuffer = '';

      currentStream = streamChatCompletion({
        messages: [{ role: 'user', content: text }],
        temperature: 0.7,
        maxTokens: 2048,
        onThinking: (token) => {
          thinkingBuffer += token;
          updateAssistantDiv(thinkingBuffer, contentBuffer);
        },
        onToken: (token) => {
          contentBuffer += token;
          updateAssistantDiv(thinkingBuffer, contentBuffer);
        },
        onDone: (fullText, fullThinking) => {
          document.getElementById('streaming-response')?.removeAttribute('id');
          statusEl.textContent = 'Ready';
          isStreaming = false;
          sendBtn.disabled = false;
          userInput.focus();
        },
        onError: (err) => {
          assistantDiv.textContent = `❌ Error: ${err.message}`;
          statusEl.textContent = 'Error — check console';
          console.error('[MKQ AI Error]', err);
          isStreaming = false;
          sendBtn.disabled = false;
        },
      });
    }

    function updateAssistantDiv(thinking, content) {
      const div = document.getElementById('streaming-response');
      if (!div) return;
      let html = '';
      if (thinking) html += `<span class="thinking">💭 ${escapeHtml(thinking)}</span><br>`;
      html += escapeHtml(content);
      div.innerHTML = html;
      chatBox.scrollTop = chatBox.scrollHeight;
    }

    sendBtn.addEventListener('click', sendMessage);
    userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  </script>
</body>
</html>
*/
