try { require("dns").setDefaultResultOrder("ipv4first"); } catch (_) {}
const fs = require("fs");
const path = require("path");
const { fetchWithRetry } = require("./http");

const TELEGRAM_CONFIG_FILE = path.join(__dirname, "../telegram.json");
const TELEGRAM_STATE_FILE = path.join(__dirname, "../telegram_state.json");

/**
 * Loads Telegram configuration from telegram.json.
 */
function loadTelegramConfig() {
  if (!fs.existsSync(TELEGRAM_CONFIG_FILE)) {
    return { enabled: false, botToken: "", chatId: "" };
  }
  try {
    const raw = fs.readFileSync(TELEGRAM_CONFIG_FILE, "utf-8");
    const stripped = raw.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*/g, "$1");
    const config = JSON.parse(stripped);
    return {
      enabled: Boolean(config.enabled && config.botToken && config.chatId),
      botToken: config.botToken || "",
      chatId: config.chatId || "",
    };
  } catch (err) {
    return { enabled: false, botToken: "", chatId: "" };
  }
}

/**
 * Loads Telegram state (routine message IDs & gift card messages).
 */
function loadTelegramState() {
  if (!fs.existsSync(TELEGRAM_STATE_FILE)) {
    return { routineMessageIds: [], giftCardMessages: {} };
  }
  try {
    const raw = fs.readFileSync(TELEGRAM_STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    return { routineMessageIds: [], giftCardMessages: {} };
  }
}

/**
 * Saves Telegram state atomically.
 */
function saveTelegramState(state) {
  const tmpFile = `${TELEGRAM_STATE_FILE}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), "utf-8");
    fs.renameSync(tmpFile, TELEGRAM_STATE_FILE);
  } catch (err) {
    console.error("Failed to save telegram state:", err.message);
  }
}

/**
 * Sends HTML-formatted message to Telegram via Bot API.
 */
async function sendTelegramMessage(text, options = {}, retries = 5) {
  const config = loadTelegramConfig();
  if (!config.enabled || !config.botToken || !config.chatId) {
    return { ok: false, reason: "telegram_disabled_or_unconfigured" };
  }

  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const bodyPayload = {
    chat_id: config.chatId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
    ...options,
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      }, 2, 1000);

      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        // Enforce 500ms spacing to respect Telegram's rate limit window
        await new Promise((r) => setTimeout(r, 500));
        return { ok: true, data };
      }

      // If Telegram rate-limited us (429), wait for retry_after
      if (response.status === 429 || data.error_code === 429) {
        const retrySec = data.parameters?.retry_after || 2;
        await new Promise((r) => setTimeout(r, retrySec * 1000));
        continue;
      }

      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      } else {
        return { ok: false, error: data.description || `HTTP ${response.status}` };
      }
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      } else {
        return { ok: false, error: err.message };
      }
    }
  }
  return { ok: false, error: "Max retries exceeded" };
}

/**
 * Deletes a single message from Telegram chat.
 */
async function deleteTelegramMessage(messageId) {
  const config = loadTelegramConfig();
  if (!config.enabled || !config.botToken || !config.chatId || !messageId) {
    return { ok: false };
  }

  const url = `https://api.telegram.org/bot${config.botToken}/deleteMessage`;
  try {
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        message_id: messageId,
      }),
    }, 2, 1000);
    const data = await response.json().catch(() => ({}));
    return { ok: Boolean(response.ok && data.ok) };
  } catch (_) {
    return { ok: false };
  }
}

/**
 * Edits text of an existing Telegram message.
 */
async function editTelegramMessageText(messageId, text, options = {}) {
  const config = loadTelegramConfig();
  if (!config.enabled || !config.botToken || !config.chatId || !messageId) {
    return { ok: false };
  }

  const url = `https://api.telegram.org/bot${config.botToken}/editMessageText`;
  try {
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        message_id: messageId,
        text: text,
        parse_mode: "HTML",
        ...options,
      }),
    }, 2, 1000);
    const data = await response.json().catch(() => ({}));
    return { ok: Boolean(response.ok && data.ok), data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Answers Telegram inline button callback queries (toast feedback).
 */
async function answerCallbackQuery(callbackQueryId, text = "") {
  const config = loadTelegramConfig();
  if (!config.enabled || !config.botToken || !callbackQueryId) return;

  const url = `https://api.telegram.org/bot${config.botToken}/answerCallbackQuery`;
  try {
    await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text,
        show_alert: false,
      }),
    }, 2, 500);
  } catch (_) {}
}

/**
 * Cleans up previous routine status/progress report messages on a new cycle reset.
 * STRICT RULE: Preserves unconfirmed gift card messages!
 */
async function cleanupPreviousRoutineMessages() {
  const state = loadTelegramState();
  const toDelete = [];

  // Delete all routine status/progress messages from previous cycle
  if (state.routineMessageIds && state.routineMessageIds.length > 0) {
    toDelete.push(...state.routineMessageIds);
    state.routineMessageIds = [];
  }

  // Also check gift card messages: if CONFIRMED by user, delete it on cycle reset; if UNCONFIRMED, KEEP IT!
  const remainingGiftCards = {};
  if (state.giftCardMessages) {
    for (const [msgIdStr, gcData] of Object.entries(state.giftCardMessages)) {
      const msgId = parseInt(msgIdStr, 10);
      if (gcData.confirmed) {
        toDelete.push(msgId); // Safe to delete confirmed gift card messages
      } else {
        remainingGiftCards[msgIdStr] = gcData; // PROTECT UNCONFIRMED GIFT CARD!
      }
    }
  }
  state.giftCardMessages = remainingGiftCards;

  saveTelegramState(state);

  if (toDelete.length > 0) {
    console.log(`\n🧹 [Telegram Chat Cleanup] Deleting ${toDelete.length} previous routine message(s)...`);
    for (const msgId of toDelete) {
      await deleteTelegramMessage(msgId);
    }
  }
}

/**
 * Instantly dispatches a gift card win notification with Inline Keyboard Button (< 1s).
 */
async function sendWinAlert(winData) {
  const accountId = winData.accountId || "unknown";
  const email = winData.email || "N/A";
  const brand = (winData.brand || "Gift Card").toUpperCase();
  const denom = winData.denomination ? `$${winData.denomination}` : "";
  const code = winData.codeOrUrl || "N/A";
  const callbackData = `confirm_gc:${Date.now()}`;

  const message = [
    `<b>🎉 GIFT CARD WINNER ALERT! 🎉</b>`,
    `<b>👤 Account:</b> <code>${accountId}</code> (${email})`,
    `<b>🎁 Prize:</b> <b>${brand} ${denom}</b>`,
    `<b>📦 Pack Tier:</b> ${(winData.packTier || "standard").toUpperCase()}`,
    `<b>📅 Time:</b> ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
    ``,
    `<b>🔗 Claim URL / Voucher Code:</b>`,
    `<code>${code}</code>`,
    `<i>Status: Automatically dispatched to email & logged to wins.json</i>`,
  ].join("\n");

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "✅ Confirm & Mark Claimed", callback_data: callbackData }
      ]
    ]
  };

  const res = await sendTelegramMessage(message, { reply_markup: replyMarkup });

  if (res.ok && res.data?.result?.message_id) {
    const msgId = res.data.result.message_id;
    const state = loadTelegramState();
    state.giftCardMessages = state.giftCardMessages || {};
    state.giftCardMessages[msgId] = {
      accountId,
      email,
      brand,
      denom,
      code,
      confirmed: false,
      callbackData,
      timestamp: new Date().toISOString(),
    };
    saveTelegramState(state);
  }

  return res;
}

/**
 * Dispatches an instant Telegram report immediately when a single account finishes processing.
 */
async function sendAccountReport(accData) {
  let message = "";
  if (accData.error) {
    message = [
      `<b>⚠️ YAPCASH ACCOUNT UPDATE</b>`,
      `<b>👤 Account:</b> <code>${accData.accountId}</code>`,
      `❌ <b>Status:</b> <i>Execution Failed (${accData.error})</i>`,
    ].join("\n");
  } else {
    const startXp = accData.startXp ?? "N/A";
    const endXp = accData.endXp ?? "N/A";
    const gainedXp = accData.xpGained || 0;
    const streak = accData.streak ?? "N/A";

    const bonusMsg = accData.bonusAwarded ? ` (+${accData.bonusAwarded} XP)` : "";
    const spinMsg = accData.spinAwarded ? ` (+${accData.spinAwarded} XP)` : "";

    let packStatus = "None";
    if (accData.packOpens && accData.packOpens.length > 0) {
      const wins = accData.packOpens.filter(p => p.ok && p.isWin);
      if (wins.length > 0) {
        packStatus = wins.map(w => `🎉 <b>WINNER (${w.packId.toUpperCase()}):</b> ${w.brand} $${w.denom}`).join("\n    ");
      } else {
        packStatus = accData.packOpens.map(p => `${p.packId}: ${p.status}`).join(", ");
      }
    }

    message = [
      `<b>✅ YAPCASH ACCOUNT COMPLETED</b>`,
      `<b>👤 Account:</b> <code>${accData.accountId}</code> (${accData.email})`,
      `<b>📈 XP Progress:</b> ${startXp} ➔ <b>${endXp} XP</b> (+${gainedXp} XP farmed 🎯)`,
      `<b>🔥 Streak:</b> ${streak} Days${bonusMsg}`,
      `<b>🎡 Wheel Spin:</b> ${spinMsg || " Claimed"}`,
      `<b>📦 Pack Status:</b> ${packStatus}`,
      `<i>Time: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</i>`,
    ].join("\n");
  }

  const res = await sendTelegramMessage(message);

  if (res.ok && res.data?.result?.message_id) {
    const msgId = res.data.result.message_id;
    const state = loadTelegramState();
    state.routineMessageIds = state.routineMessageIds || [];
    state.routineMessageIds.push(msgId);
    saveTelegramState(state);
  }

  return res;
}

/**
 * Compiles and sends the complete end-of-cycle daily summary report.
 */
async function sendDailyReport(reportData) {
  const accounts = reportData.accounts || [];
  const dateStr = new Date().toISOString().split("T")[0];

  let totalXpFarmed = 0;
  let totalWinsCount = 0;
  let activeCount = 0;

  accounts.forEach((acc) => {
    if (!acc.error) {
      activeCount++;
      totalXpFarmed += (acc.xpGained || 0);
      if (acc.packOpens) {
        totalWinsCount += acc.packOpens.filter(p => p.ok && p.isWin).length;
      }
    }
  });

  const reportMessage = [
    `<b>📊 YAPCASH DAILY CYCLE SUMMARY</b>`,
    `<b>📈 Total XP Farmed:</b> +${totalXpFarmed.toLocaleString()} XP (${activeCount}/${accounts.length} Accounts)`,
    `<b>🎁 Gift Cards Won:</b> ${totalWinsCount} Wins`,
    `<i>📅 ${dateStr} | Daemon active 24/7</i>`,
  ].join("\n");

  const res = await sendTelegramMessage(reportMessage);

  if (res.ok && res.data?.result?.message_id) {
    const msgId = res.data.result.message_id;
    const state = loadTelegramState();
    state.routineMessageIds = state.routineMessageIds || [];
    state.routineMessageIds.push(msgId);
    saveTelegramState(state);
  }

  return res;
}

/**
 * Background Polling Listener: Listens for Telegram inline button taps (`callback_query`).
 */
let isPollingActive = false;
let updateOffset = 0;

function startTelegramPollingListener() {
  const config = loadTelegramConfig();
  if (!config.enabled || !config.botToken || isPollingActive) return;

  isPollingActive = true;

  const pollLoop = async () => {
    while (isPollingActive) {
      try {
        const url = `https://api.telegram.org/bot${config.botToken}/getUpdates?offset=${updateOffset}&timeout=20`;
        const res = await fetchWithRetry(url, { method: "GET" }, 1, 1000).catch(() => null);

        if (res && res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.ok && Array.isArray(data.result)) {
            for (const update of data.result) {
              updateOffset = update.update_id + 1;

              if (update.callback_query) {
                await handleCallbackQuery(update.callback_query);
              }
            }
          }
        }
      } catch (_) {}

      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  pollLoop().catch(() => {});
}

/**
 * Handles callback_query when user taps [ ✅ Confirm & Mark Claimed ].
 */
async function handleCallbackQuery(callbackQuery) {
  const cbId = callbackQuery.id;
  const cbData = callbackQuery.data;
  const message = callbackQuery.message;

  if (!message || !message.message_id) return;
  const msgId = message.message_id;

  if (cbData && cbData.startsWith("confirm_gc:")) {
    const state = loadTelegramState();
    if (state.giftCardMessages && state.giftCardMessages[msgId]) {
      state.giftCardMessages[msgId].confirmed = true;
      state.giftCardMessages[msgId].confirmedAt = new Date().toISOString();
      saveTelegramState(state);

      const gc = state.giftCardMessages[msgId];

      const updatedText = [
        `<b>✅ GIFT CARD CLAIMED & CONFIRMED BY YOU!</b>`,
        `<b>👤 Account:</b> <code>${gc.accountId}</code> (${gc.email})`,
        `<b>🎁 Prize:</b> <b>${gc.brand} ${gc.denom}</b>`,
        `<b>📅 Claimed At:</b> ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
        ``,
        `<b>🔗 Claim URL / Voucher Code:</b>`,
        `<code>${gc.code}</code>`,
        `<i>Status: Verified and archived</i>`,
      ].join("\n");

      // Edit Telegram message to update status text and remove inline button
      await editTelegramMessageText(msgId, updatedText, { reply_markup: { inline_keyboard: [] } });

      // Toast response back to Telegram app
      await answerCallbackQuery(cbId, "✅ Gift Card claim confirmed!");
    } else {
      await answerCallbackQuery(cbId, "✅ Confirmed!");
    }
  }
}

module.exports = {
  loadTelegramConfig,
  loadTelegramState,
  saveTelegramState,
  sendTelegramMessage,
  deleteTelegramMessage,
  editTelegramMessageText,
  cleanupPreviousRoutineMessages,
  sendWinAlert,
  sendAccountReport,
  sendDailyReport,
  startTelegramPollingListener,
};
