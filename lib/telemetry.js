const crypto = require("crypto");

// Exact extension weighted XP probability distribution table from background.js
const XP_TABLE = [
  10,10,10,10,10,10,10,10,10,10,
  10,10,10,10,10,10,10,10,10,10,
  10,10,10,10,10,
  15,15,15,15,15,15,15,15,15,15,
  15,15,15,15,15,15,15,15,15,15,
  15,15,15,15,15,15,15,15,15,15,
  20,20,20,20,20,20,20,20,20,20,
  20,20,20,20,20,20,20,20,
  50,50,50,50,50,50,50,50,50,50,
  100,100,100,100,100,
  200,200
];

function pickVariableXp() {
  return XP_TABLE[Math.floor(Math.random() * XP_TABLE.length)];
}

/**
 * Builds realistic telemetry and active-time payloads to send with flush_session.
 */
function createTelemetryPayload(options = {}) {
  const activeSeconds = options.activeSeconds || Math.floor(Math.random() * 60) + 120; // 2 to 3 mins
  const messages = options.messages || Math.floor(Math.random() * 3) + 1; // 1 to 3 messages
  const chatXp = options.chatXp || pickVariableXp();

  return {
    active_seconds: activeSeconds,
    messages: messages,
    chat_xp: chatXp,
  };
}

/**
 * Sends session telemetry to Supabase RPC 'flush_session' matching extension background schema.
 */
async function flushSession(client, options = {}) {
  const provider = options.provider || "chatgpt";
  const now = new Date();
  const today = now.toISOString().split("T")[0];

  const payload = {
    p_session_date: today,
    p_messages_delta: options.messages || 1,
    p_chat_xp_delta: options.chatXp || 25,
    p_providers: [provider],
    p_first_active_at: new Date(now.getTime() - 60000).toISOString(),
    p_last_active_at: now.toISOString(),
    p_active_seconds_delta: options.activeSeconds || 15,
    p_tab_switches_delta: 1,
    p_away_seconds_delta: 0,
    p_copy_event: false,
    p_model_detected: "gpt-4o",
  };

  try {
    const result = await client.rpc("flush_session", payload);
    return { ok: true, result };
  } catch (err) {
    // Non-fatal telemetry error
    return { ok: false, error: err.message };
  }
}

/**
 * Builds a single client event payload structure matching extension background logic.
 */
function createClientEvent(provider = "chatgpt", xpAwarded = 15) {
  const hosts = {
    chatgpt: "chatgpt.com",
    claude: "claude.ai",
    perplexity: "www.perplexity.ai",
    gemini: "gemini.google.com",
  };

  return {
    provider: provider,
    eventType: "ai_message",
    source: "content_script",
    timestamp: new Date().toISOString(),
    urlHost: hosts[provider] || "chatgpt.com",
    xpAwarded: xpAwarded,
    clientEventId: crypto.randomUUID(),
    contentCaptured: false,
  };
}

module.exports = {
  createTelemetryPayload,
  flushSession,
  createClientEvent,
  pickVariableXp,
};
