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
 * Deletes a single message from Telegram chat with rate-limit retry support.
 */
async function deleteTelegramMessage(messageId, options = {}, retries = 3) {
  const config = loadTelegramConfig();
  const chatId = options.chatId || config.chatId;
  if (!config.enabled || !config.botToken || !chatId || !messageId) {
    return { ok: false };
  }

  const url = `https://api.telegram.org/bot${config.botToken}/deleteMessage`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
        }),
      }, 2, 500);

      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        await new Promise((r) => setTimeout(r, 250)); // Enforce 250ms spacing between deletions
        return { ok: true };
      }

      // If Telegram rate-limited us (429), wait for retry_after
      if (response.status === 429 || data.error_code === 429) {
        const retrySec = data.parameters?.retry_after || 2;
        await new Promise((r) => setTimeout(r, retrySec * 1000));
        continue;
      }

      // If message is too old (> 48h), Telegram forbids deletion
      if (data.description && data.description.includes("can't be deleted")) {
        return { ok: false, reason: "too_old" };
      }

      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    } catch (_) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  return { ok: false };
}

/**
 * Edits text of an existing Telegram message.
 */
async function editTelegramMessageText(messageId, text, options = {}) {
  const config = loadTelegramConfig();
  const chatId = options.chatId || config.chatId;
  if (!config.enabled || !config.botToken || !chatId || !messageId) {
    return { ok: false };
  }

  const url = `https://api.telegram.org/bot${config.botToken}/editMessageText`;
  try {
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: text,
        parse_mode: "HTML",
        ...options,
      }),
    }, 2, 500);
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
 * Background Polling Listener: Listens for Telegram text commands (/openpack, /pack) and inline button taps.
 * Flushes stale pending updates on startup to ensure instant button responsiveness.
 */
let isPollingActive = false;
let updateOffset = 0;

const activePackLocks = new Map();
const activeMenuSessions = new Map();

function startTelegramPollingListener() {
  const config = loadTelegramConfig();
  if (!config.enabled || !config.botToken || isPollingActive) return;

  isPollingActive = true;

  const pollLoop = async () => {
    // Flush stale pending updates on startup so old clicks don't cause hanging spinners
    if (updateOffset === 0) {
      try {
        const flushUrl = `https://api.telegram.org/bot${config.botToken}/getUpdates?offset=-1`;
        const fetchOpts = { method: "GET" };
        if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
          fetchOpts.signal = AbortSignal.timeout(15000);
        }
        const res = await fetchWithRetry(flushUrl, fetchOpts, 1, 1000).catch(() => null);
        if (res && res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.ok && Array.isArray(data.result) && data.result.length > 0) {
            updateOffset = data.result[data.result.length - 1].update_id + 1;
          }
        }
      } catch (_) {}
    }

    while (isPollingActive) {
      try {
        // Use short 5-second long-polling timeout with 15s AbortSignal so HTTP requests never abort during sleep
        const url = `https://api.telegram.org/bot${config.botToken}/getUpdates?offset=${updateOffset}&timeout=5`;
        const fetchOpts = { method: "GET" };
        if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
          fetchOpts.signal = AbortSignal.timeout(15000);
        }

        const res = await fetchWithRetry(url, fetchOpts, 1, 1000).catch(() => null);

        if (res && res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data.ok && Array.isArray(data.result)) {
            for (const update of data.result) {
              updateOffset = update.update_id + 1;

              // Handle incoming text commands (/openpack, /pack, /help)
              if (update.message && update.message.text) {
                await handleTextMessage(update.message);
              }

              // Handle inline button taps
              if (update.callback_query) {
                await handleCallbackQuery(update.callback_query);
              }
            }
          }
        }
      } catch (_) {}

      await new Promise((r) => setTimeout(r, 500));
    }
  };

  // Self-healing loop: Automatically restarts if any unexpected error terminates pollLoop
  const runSelfHealingLoop = async () => {
    while (true) {
      isPollingActive = true;
      await pollLoop().catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  runSelfHealingLoop().catch(() => {});
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
    let deletedCount = 0;
    for (const msgId of toDelete) {
      // 1. Glitter animation edit before deletion
      await editTelegramMessageText(msgId, "✨ 🧹 <i>Glittering cleanup...</i> 💫").catch(() => {});
      await new Promise((r) => setTimeout(r, 200));

      // 2. Execute deletion
      const res = await deleteTelegramMessage(msgId);
      if (res.ok) deletedCount++;
    }
    console.log(`  └─ Successfully deleted ${deletedCount}/${toDelete.length} message(s).`);
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
    const weekMsg = accData.weekBonusAwarded ? ` (+${accData.weekBonusAwarded} XP)` : "";

    let packStatus = "Saved (XP Hoarded for /openpack)";
    if (accData.packOpens && accData.packOpens.length > 0) {
      const wins = accData.packOpens.filter(p => p.ok && p.isWin);
      if (wins.length > 0) {
        packStatus = wins.map(w => `🎉 <b>WINNER (${w.packId.toUpperCase()}):</b> ${w.brand} $${w.denom}`).join("\n    ");
      } else {
        packStatus = accData.packOpens.map(p => `${p.packId}: ${p.status}`).join(", ");
      }
    }

    const country = accData.rewardCountry || "US";
    let flag = "🇺🇸";
    if (country === "GB") flag = "🇬🇧";
    else if (country === "NG") flag = "🇳🇬";
    else if (country === "CA") flag = "🇨🇦";
    else if (country === "AU") flag = "🇦🇺";

    message = [
      `<b>✅ YAPCASH ACCOUNT COMPLETED</b>`,
      `<b>👤 Account:</b> <code>${accData.accountId}</code> (${accData.email})`,
      `<b>🌍 Region:</b> ${flag} <b>${country}</b>`,
      `<b>📈 XP Progress:</b> ${startXp} ➔ <b>${endXp} XP</b> (+${gainedXp} XP farmed 🎯)`,
      `<b>🔥 Streak:</b> ${streak} Days${bonusMsg}`,
      `<b>🎡 Wheel Spin:</b> ${spinMsg || " Claimed"}`,
      `<b>📅 Weekly Bonus:</b> ${weekMsg || " Claimed"}`,
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
  let totalStreakBonus = 0;
  let totalSpinBonus = 0;
  let totalWeekBonus = 0;
  let portfolioTotalXp = 0;
  let activeCount = 0;

  accounts.forEach((acc) => {
    if (!acc.error) {
      activeCount++;
      totalXpFarmed += (acc.xpGained || 0);
      totalStreakBonus += (acc.bonusAwarded || 0);
      totalSpinBonus += (acc.spinAwarded || 0);
      totalWeekBonus += (acc.weekBonusAwarded || 0);
      if (typeof acc.endXp === "number") {
        portfolioTotalXp += acc.endXp;
      }
    }
  });

  const reportMessage = [
    `<b>📊 YAPCASH EXECUTIVE DAILY SUMMARY</b>`,
    `────────────────────────`,
    `📈 <b>Daily XP Farmed:</b>    +${totalXpFarmed.toLocaleString()} XP`,
    `🔥 <b>Streak Bonus XP:</b>    +${totalStreakBonus.toLocaleString()} XP`,
    `🎡 <b>Wheel Spin XP:</b>      +${totalSpinBonus.toLocaleString()} XP`,
    `📅 <b>Weekly Bonus XP:</b>    +${totalWeekBonus.toLocaleString()} XP`,
    `💰 <b>Portfolio Total XP:</b>  ${portfolioTotalXp.toLocaleString()} XP (${activeCount}/${accounts.length} Accounts)`,
    `────────────────────────`,
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
 * Sends a rich live notification card whenever an account token is updated (via API or Telegram).
 */
async function sendTokenUpdateNotification(accEntry) {
  const flag = accEntry.rewardCountry === "GB" ? "🇬🇧" : (accEntry.rewardCountry === "NG" ? "🇳🇬" : "🇺🇸");
  const lines = [
    `⚡ <b>LIVE ACCOUNT TOKEN SYNCED!</b>`,
    `────────────────────────`,
    `👤 <b>Account:</b> <code>${accEntry.accountId}</code> (${flag} ${accEntry.rewardCountry || "US"})`,
    `📧 <b>Email:</b> <code>${accEntry.email}</code>`,
    `⚡ <b>Total XP:</b> <b>${(accEntry.totalXp ?? 0).toLocaleString()} XP</b>`,
    `🔥 <b>Streak:</b> <b>${accEntry.streak ?? "N/A"} Days</b>`,
    `📅 <b>Updated At:</b> ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
    `────────────────────────`,
    `<i>Koyeb cloud server state updated in real-time!</i>`,
  ];

  const inlineKeyboard = [
    [
      { text: "📦 Open Pack", callback_data: `pack_acc:${accEntry.accountId}` },
      { text: "💥 Smart Drain", callback_data: `smart_drain:${accEntry.accountId}` },
    ],
    [
      { text: "📊 Status Overview", callback_data: "show_status" },
      { text: "🔄 Restart Server", callback_data: "restart_server" },
    ],
  ];

  return await sendTelegramMessage(lines.join("\n"), {
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

/**
 * Renders and sends the Master Control Panel inline keyboard menu.
 */
async function sendMasterControlMenu() {
  const text = [
    `<b>🤖 YAPCASH MASTER BOT CONTROL PANEL</b>`,
    `────────────────────────`,
    `Manage your 14-account farming network with 1-tap inline buttons:`,
    `• <b>Restart Server:</b> Reboots Koyeb container process instantly`,
    `• <b>Status Overview:</b> View live XP, streak & connectivity`,
    `• <b>Open Reward Pack:</b> Interactive pack tier unboxing`,
    `• <b>Smart Auto-Drain:</b> Master waterfall pack opener`,
    `────────────────────────`,
  ].join("\n");

  const inlineKeyboard = [
    [
      { text: "📦 Open Reward Pack", callback_data: "open_pack_menu" },
      { text: "💥 Smart Auto-Drain", callback_data: "smart_drain:ALL" },
    ],
    [
      { text: "📊 Status Overview", callback_data: "show_status" },
      { text: "🔄 Restart Server", callback_data: "restart_server" },
    ],
  ];

  return await sendTelegramMessage(text, {
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

/**
 * Parses and handles incoming text commands from Telegram chat.
 */
async function handleTextMessage(msg) {
  const text = (msg.text || "").trim();
  if (!text.startsWith("/")) return;

  const command = text.split(" ")[0].toLowerCase();
  if (command === "/openpack" || command === "/pack" || command === "/smartdrain" || command === "/drain") {
    await sendAccountPickerMenu(msg);
  } else if (command === "/restart" || command === "/reboot") {
    await sendTelegramMessage("🔄 <b>Reboot Request Received!</b>\n<i>Rebooting Koyeb NodeJS container process...</i>");
    setTimeout(() => process.exit(0), 1000);
  } else if (command === "/menu" || command === "/start") {
    await sendMasterControlMenu();
  } else if (command === "/status") {
    await sendStatusReportMessage();
  } else if (command === "/help" || command === "/help@bot") {
    await sendMasterControlMenu();
  }
}

/**
 * Helper to fetch an account's live total_xp balance in parallel with an 800ms timeout cap.
 */
async function fetchAccountXpFast(acc, timeoutMs = 1200) {
  try {
    const SupabaseClient = require("./supabaseClient");
    const client = new SupabaseClient(acc);
    const fetchPromise = (async () => {
      const session = await client.ensureAuthenticated().catch(() => null);
      if (session) {
        const userState = await client.getUserState().catch(() => null);
        if (userState) {
          const country = userState.reward_country || "US";
          let flag = "🇺🇸";
          if (country === "GB") flag = "🇬🇧";
          else if (country === "NG") flag = "🇳🇬";
          else if (country === "CA") flag = "🇨🇦";
          else if (country === "AU") flag = "🇦🇺";
          return { xp: userState.total_xp, country, flag };
        }
      }
      return null;
    })();

    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
    return await Promise.race([fetchPromise, timeoutPromise]);
  } catch (_) {
    return null;
  }
}

/**
 * Sends or updates the Account Picker inline menu with live XP balance badges (fetched in parallel < 800ms).
 */
async function sendAccountPickerMenu(msgOrId, isEdit = false) {
  const { loadAccounts } = require("./accountManager");
  const accounts = loadAccounts();

  if (accounts.length === 0) {
    return sendTelegramMessage("❌ No accounts configured in accounts.json");
  }

  // Fetch all account XP balances and reward countries concurrently in parallel
  const infoResults = await Promise.all(accounts.map((acc) => fetchAccountXpFast(acc, 1200)));

  const inlineKeyboard = [];
  let row = [];

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const info = infoResults[i];
    const flagBadge = info && info.flag ? `${info.flag} ` : "";
    const xpBadge = info && typeof info.xp === "number" ? ` (${info.xp.toLocaleString()} XP)` : "";

    row.push({
      text: `${flagBadge}${acc.accountId}${xpBadge}`,
      callback_data: `pack_acc:${acc.accountId}`,
    });

    if (row.length === 2 || i === accounts.length - 1) {
      inlineKeyboard.push(row);
      row = [];
    }
  }

  inlineKeyboard.push([{ text: "🚀 ALL Accounts", callback_data: "pack_acc:ALL" }]);
  inlineKeyboard.push([{ text: "🗑️ Dismiss Menu", callback_data: "dismiss_msg" }]);

  const menuText = [
    `<b>🎁 YAPCASH REWARD PACK OPENER</b>`,
    `Select an account to choose which pack tier to open:`,
    `<i>Session auto-expires in 2 minutes</i>`,
  ].join("\n");

  let msgId = null;
  if (isEdit) {
    msgId = msgOrId;
    await editTelegramMessageText(msgId, menuText, {
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  } else {
    const res = await sendTelegramMessage(menuText, {
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
    if (res.ok && res.data?.result?.message_id) {
      msgId = res.data.result.message_id;
    }
  }

  if (msgId) {
    if (activeMenuSessions.has(msgId)) {
      clearTimeout(activeMenuSessions.get(msgId));
    }
    const timer = setTimeout(async () => {
      activeMenuSessions.delete(msgId);
      await editTelegramMessageText(msgId, "<i>⌛ Pack session expired. Send /openpack to start new session.</i>", {
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }, 120000); // 2 min auto-expiry

    activeMenuSessions.set(msgId, timer);
  }
}

/**
 * Renders the Pack Tier selection inline menu with affordability tags (🟢 Ready / 🔒 Need X XP).
 */
async function sendTierPickerMenu(msgId, targetAccountId) {
  const { loadAccounts } = require("./accountManager");
  const accounts = loadAccounts();

  let totalXp = null;
  if (targetAccountId !== "ALL") {
    const acc = accounts.find((a) => a.accountId === targetAccountId);
    if (acc) {
      totalXp = await fetchAccountXpFast(acc, 800);
    }
  }

  const packTiers = [
    { id: "standard", name: "Standard Pack", cost: 500 },
    { id: "rare", name: "Rare Pack", cost: 1000 },
    { id: "elite", name: "Elite Pack", cost: 2000 },
  ];

  const inlineKeyboard = [];

  packTiers.forEach((tier) => {
    let statusText = "🟢 Ready";
    let isLocked = false;

    if (targetAccountId !== "ALL" && typeof totalXp === "number" && totalXp < tier.cost) {
      isLocked = true;
      const diff = tier.cost - totalXp;
      statusText = `🔒 Need ${diff.toLocaleString()} XP`;
    }

    const callbackData = isLocked
      ? `locked_pack:${tier.cost}`
      : `pack_tier:${targetAccountId}:${tier.id}`;

    inlineKeyboard.push([
      {
        text: `${tier.name} (${tier.cost.toLocaleString()} XP) — ${statusText}`,
        callback_data: callbackData,
      },
    ]);
  });

  inlineKeyboard.push([
    {
      text: `💥 Smart Auto-Drain (Elite ➔ Rare ➔ Standard)`,
      callback_data: `smart_drain:${targetAccountId}`,
    },
  ]);

  inlineKeyboard.push([
    { text: "🔙 Change Account", callback_data: "pack_back_acc" },
    { text: "🗑️ Dismiss", callback_data: "dismiss_msg" },
  ]);

  const targetLabel = targetAccountId === "ALL"
    ? "ALL Accounts"
    : (typeof totalXp === "number" ? `${targetAccountId} (${totalXp.toLocaleString()} XP)` : targetAccountId);

  const menuText = [
    `<b>📦 SELECT PACK TIER</b>`,
    `<b>👤 Target:</b> <code>${targetLabel}</code>`,
    `Choose a pack tier to open for this target:`,
    `<i>Session auto-expires in 2 minutes</i>`,
  ].join("\n");

  await editTelegramMessageText(msgId, menuText, {
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

/**
 * Handles pack unboxing animation sequence and API execution for chosen target & tier.
 */
async function executePackOpeningSequence(msgId, targetAccountId, packTier) {
  const { loadAccounts } = require("./accountManager");
  const SupabaseClient = require("./supabaseClient");
  const { openRewardPack } = require("./apiTasks");

  if (activePackLocks.get(targetAccountId)) {
    await editTelegramMessageText(msgId, `⚠️ <b>Lock Active:</b> Pack opening in progress for ${targetAccountId}. Please wait.`, {
      reply_markup: { inline_keyboard: [[{ text: "🗑️ Dismiss", callback_data: "dismiss_msg" }]] },
    });
    return;
  }

  activePackLocks.set(targetAccountId, true);

  if (activeMenuSessions.has(msgId)) {
    clearTimeout(activeMenuSessions.get(msgId));
    activeMenuSessions.delete(msgId);
  }

  try {
    // Animation Stage 1: Shaking pack
    await editTelegramMessageText(msgId, `🎁 <i>Shaking ${packTier.toUpperCase()} pack for ${targetAccountId}...</i>`, {
      reply_markup: { inline_keyboard: [] },
    });
    await new Promise((r) => setTimeout(r, 300));

    // Animation Stage 2: Tearing open foil
    await editTelegramMessageText(msgId, `✨ <i>Tearing open the seal for ${targetAccountId}... 💫</i>`, {
      reply_markup: { inline_keyboard: [] },
    });
    await new Promise((r) => setTimeout(r, 400));

    const accounts = loadAccounts();
    const targetAccounts = targetAccountId === "ALL"
      ? accounts
      : accounts.filter((a) => a.accountId === targetAccountId);

    if (targetAccounts.length === 0) {
      await editTelegramMessageText(msgId, `❌ Account '${targetAccountId}' not found.`, {
        reply_markup: { inline_keyboard: [[{ text: "🗑️ Dismiss", callback_data: "dismiss_msg" }]] },
      });
      activePackLocks.delete(targetAccountId);
      return;
    }

    const results = [];
    for (const acc of targetAccounts) {
      const client = new SupabaseClient(acc);
      const res = await openRewardPack(client, packTier);
      results.push({ accountId: acc.accountId, res });
    }

    // Animation Stage 3: REVEAL
    const cardLines = [
      `<b>💥 PACK UNBOXING REVEAL! 💥</b>`,
      `<b>📦 Pack Tier:</b> ${packTier.toUpperCase()}`,
      `────────────────────────`,
    ];

    let hasGiftCardWin = false;

    results.forEach(({ accountId, res }) => {
      if (res.ok && res.isWin && res.giftCard) {
        hasGiftCardWin = true;
        cardLines.push(`🎉 <b>${accountId}: GIFT CARD WINNER!</b>`);
        cardLines.push(`   🎁 <b>Brand:</b> ${res.giftCard.brand.toUpperCase()} $${res.giftCard.denomination}`);
        cardLines.push(`   🔑 <b>Claim Code:</b> <code>${res.giftCard.code}</code>`);
      } else if (res.ok && res.xpAwarded > 0) {
        cardLines.push(`⚡ <b>${accountId}:</b> <b>+${res.xpAwarded.toLocaleString()} XP Bonus Won!</b>`);
      } else if (res.ok) {
        cardLines.push(`✨ <b>${accountId}:</b> ${res.message || "Pack opened successfully!"}`);
      } else {
        const raw = `${res.reason || ""} ${res.message || ""} ${res.error || ""}`.toLowerCase();
        let reasonLabel = res.message || res.reason || "Failed";

        if (raw.includes("insufficient_balance") || raw.includes("insufficient xp") || raw.includes("not enough xp")) {
          reasonLabel = "🔒 Insufficient XP Balance to open pack";
        } else if (raw.includes("reward_country_required") || raw.includes("country required")) {
          reasonLabel = "🌍 Account country verification required";
        } else if (raw.includes("rewards_unavailable_in_region") || raw.includes("unavailable in country")) {
          reasonLabel = "🌐 Packs unavailable in account's region";
        } else if (raw.includes("unresolved_gift_card") || raw.includes("pending gift card")) {
          reasonLabel = "🎁 Pending unfulfilled gift card needs recovery first";
        } else if (raw.includes("winner_cooldown")) {
          reasonLabel = "⏳ Winner cooldown active on account";
        } else if (raw.includes("reward_pool_depleted") || raw.includes("depleted or closed")) {
          reasonLabel = "🔋 Global reward pool is depleted or locked";
        }
        cardLines.push(`⚠️ <b>${accountId}:</b> ${reasonLabel}`);
      }
    });

    cardLines.push(`────────────────────────`);
    cardLines.push(`<i>Time: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</i>`);

    await editTelegramMessageText(msgId, cardLines.join("\n"), {
      reply_markup: { inline_keyboard: [[{ text: "🗑️ Dismiss", callback_data: "dismiss_msg" }]] },
    });

    // Timed Auto-Cleanup for non-win XP reveals after 60 seconds
    if (!hasGiftCardWin) {
      setTimeout(async () => {
        await editTelegramMessageText(msgId, "✨ 🧹 <i>Glittering cleanup...</i> 💫", {
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 250));
        await deleteTelegramMessage(msgId).catch(() => {});
      }, 60000);
    }
  } catch (err) {
    await editTelegramMessageText(msgId, `❌ Pack opening error: ${err.message}`, {
      reply_markup: { inline_keyboard: [[{ text: "🗑️ Dismiss", callback_data: "dismiss_msg" }]] },
    });
  } finally {
    activePackLocks.delete(targetAccountId);
  }
}

/**
 * Handles the Master Smart Auto-Drain Waterfall sequence across all eligible packs.
 */
async function executeSmartDrainSequence(msgId, targetAccountId) {
  const { loadAccounts } = require("./accountManager");
  const SupabaseClient = require("./supabaseClient");
  const { drainAccountPacks } = require("./apiTasks");

  if (activePackLocks.get(targetAccountId)) {
    await editTelegramMessageText(msgId, `⚠️ <b>Lock Active:</b> Pack draining in progress for ${targetAccountId}. Please wait.`, {
      reply_markup: { inline_keyboard: [[{ text: "🗑️ Dismiss", callback_data: "dismiss_msg" }]] },
    });
    return;
  }

  activePackLocks.set(targetAccountId, true);

  if (activeMenuSessions.has(msgId)) {
    clearTimeout(activeMenuSessions.get(msgId));
    activeMenuSessions.delete(msgId);
  }

  try {
    // Animation Stage 1: Initializing Waterfall Engine
    await editTelegramMessageText(msgId, `💥 <i>Initializing Master Smart Waterfall Engine for ${targetAccountId}...</i>`, {
      reply_markup: { inline_keyboard: [] },
    });
    await new Promise((r) => setTimeout(r, 400));

    // Animation Stage 2: Draining Eligible Packs
    await editTelegramMessageText(msgId, `🌊 <i>Draining packs top-down (Elite ➔ Rare ➔ Standard) for ${targetAccountId}... 💫</i>`, {
      reply_markup: { inline_keyboard: [] },
    });
    await new Promise((r) => setTimeout(r, 500));

    const accounts = loadAccounts();
    const targetAccounts = targetAccountId === "ALL"
      ? accounts
      : accounts.filter((a) => a.accountId === targetAccountId);

    if (targetAccounts.length === 0) {
      await editTelegramMessageText(msgId, `❌ Account '${targetAccountId}' not found.`, {
        reply_markup: { inline_keyboard: [[{ text: "🗑️ Dismiss", callback_data: "dismiss_msg" }]] },
      });
      activePackLocks.delete(targetAccountId);
      return;
    }

    const drainResults = [];
    for (const acc of targetAccounts) {
      const client = new SupabaseClient(acc);
      const res = await drainAccountPacks(client, 10);
      drainResults.push({ accountId: acc.accountId, res });
    }

    // Animation Stage 3: MASTER WATERFALL REVEAL
    const cardLines = [
      `<b>💥 MASTER SMART AUTO-DRAIN REVEAL! 💥</b>`,
      `<b>👤 Target:</b> <code>${targetAccountId}</code>`,
      `────────────────────────`,
    ];

    drainResults.forEach(({ accountId, res }) => {
      if (res.totalOpens > 0) {
        cardLines.push(`🌊 <b>${accountId}:</b> ${res.totalOpens} Packs Opened (${res.totalXpSpent.toLocaleString()} XP Spent)`);
        res.opens.forEach((op) => {
          if (op.isWin && op.giftCard) {
            cardLines.push(`  🎉 <b>WINNER (${op.tier.toUpperCase()}):</b> ${op.giftCard.brand.toUpperCase()} $${op.giftCard.denomination}`);
            cardLines.push(`     🔑 <b>Code:</b> <code>${op.giftCard.code}</code>`);
          } else if (op.xpAwarded > 0) {
            cardLines.push(`  ⚡ <b>${op.tier.toUpperCase()}:</b> +${op.xpAwarded.toLocaleString()} XP Refund Won`);
          } else if (op.ok) {
            cardLines.push(`  ✨ <b>${op.tier.toUpperCase()}:</b> Pack Opened`);
          } else {
            cardLines.push(`  ⚠️ <b>${op.tier.toUpperCase()}:</b> ${op.reason || op.message || "Failed"}`);
          }
        });
      } else {
        cardLines.push(`ℹ️ <b>${accountId}:</b> No packs opened (XP < 500 or limits reached)`);
      }
    });

    cardLines.push(`────────────────────────`);
    cardLines.push(`<i>Time: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</i>`);

    await editTelegramMessageText(msgId, cardLines.join("\n"), {
      reply_markup: { inline_keyboard: [[{ text: "🗑️ Dismiss", callback_data: "dismiss_msg" }]] },
    });
  } catch (err) {
    await editTelegramMessageText(msgId, `❌ <b>Smart Drain Error:</b> ${err.message}`, {
      reply_markup: { inline_keyboard: [[{ text: "🗑️ Dismiss", callback_data: "dismiss_msg" }]] },
    });
  } finally {
    activePackLocks.delete(targetAccountId);
  }
}

/**
 * Handles callback_query events (inline button taps).
 */
async function handleCallbackQuery(callbackQuery) {
  const cbId = callbackQuery.id;
  const cbData = callbackQuery.data;
  const message = callbackQuery.message;

  if (!message || !message.message_id) return;
  const msgId = message.message_id;

  // Instantly acknowledge button tap so Telegram clears loading spinner immediately
  await answerCallbackQuery(cbId);

  // 0. Master Menu & Server Restart Buttons
  if (cbData === "restart_server") {
    await editTelegramMessageText(msgId, "🔄 <b>Reboot Request Received!</b>\n<i>Rebooting Koyeb NodeJS container process...</i>", {
      reply_markup: { inline_keyboard: [] },
    });
    setTimeout(() => process.exit(0), 1000);
    return;
  }

  if (cbData === "open_pack_menu") {
    await sendAccountPickerMenu(msgId, true);
    return;
  }

  if (cbData === "show_status") {
    await editTelegramMessageText(msgId, "⏳ <i>Fetching live status for 14 accounts...</i>", {
      reply_markup: { inline_keyboard: [] },
    });
    const { loadAccounts } = require("./accountManager");
    const accounts = loadAccounts();
    const infoResults = await Promise.all(accounts.map((acc) => fetchAccountXpFast(acc, 1200)));

    const lines = [
      `<b>📊 YAPCASH LIVE ACCOUNT STATUS</b>`,
      `────────────────────────`,
    ];

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const info = infoResults[i];
      const flag = info && info.flag ? info.flag : "🇺🇸";
      const xp = info && typeof info.xp === "number" ? `${info.xp.toLocaleString()} XP` : "N/A";
      lines.push(`${flag} <code>${acc.accountId}</code> — <b>${xp}</b>`);
    }

    lines.push(`────────────────────────`);
    lines.push(`<i>Time: ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</i>`);

    await editTelegramMessageText(msgId, lines.join("\n"), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📦 Open Pack", callback_data: "open_pack_menu" },
            { text: "💥 Smart Drain", callback_data: "smart_drain:ALL" },
          ],
          [
            { text: "🔄 Restart Server", callback_data: "restart_server" },
            { text: "🗑️ Dismiss", callback_data: "dismiss_msg" },
          ],
        ],
      },
    });
    return;
  }

  // 1. Confirm Gift Card Claim
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

      await editTelegramMessageText(msgId, updatedText, { reply_markup: { inline_keyboard: [] } });
    }
    return;
  }

  // 2. Dismiss Message Button
  if (cbData === "dismiss_msg") {
    if (activeMenuSessions.has(msgId)) {
      clearTimeout(activeMenuSessions.get(msgId));
      activeMenuSessions.delete(msgId);
    }
    await deleteTelegramMessage(msgId);
    return;
  }

  // 3. Locked Pack Toast Notice
  if (cbData && cbData.startsWith("locked_pack:")) {
    const reqXp = cbData.split(":")[1];
    await answerCallbackQuery(cbId, `🔒 Locked: Requires ${parseInt(reqXp, 10).toLocaleString()} XP to open`);
    return;
  }

  // 4. Back to Account Selection
  if (cbData === "pack_back_acc") {
    await sendAccountPickerMenu(msgId, true);
    return;
  }

  // 5. Account selected -> show tier menu
  if (cbData && cbData.startsWith("pack_acc:")) {
    const targetAccountId = cbData.split(":")[1];
    await sendTierPickerMenu(msgId, targetAccountId);
    return;
  }

  // 6. Smart Auto-Drain selected -> execute Master Waterfall Engine
  if (cbData && cbData.startsWith("smart_drain:")) {
    const targetAccountId = cbData.split(":")[1];
    await executeSmartDrainSequence(msgId, targetAccountId);
    return;
  }

  // 7. Pack Tier selected -> execute animated unboxing
  if (cbData && cbData.startsWith("pack_tier:")) {
    const parts = cbData.split(":");
    const targetAccountId = parts[1];
    const packTier = parts[2];
    await executePackOpeningSequence(msgId, targetAccountId, packTier);
    return;
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
  sendTokenUpdateNotification,
  sendMasterControlMenu,
  executeSmartDrainSequence,
  startTelegramPollingListener,
};

