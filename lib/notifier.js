const fs = require("fs");
const path = require("path");

const WINS_FILE = path.join(__dirname, "../wins.json");
const PACK_HISTORY_FILE = path.join(__dirname, "../pack_history.json");

const { sendWinAlert } = require("./telegram");
const { logWinToFirestore, logPackHistoryToFirestore } = require("./firebaseClient");

/**
 * Appends a gift card win entry to wins.json and Firestore cloud DB, then dispatches Telegram alert.
 */
function recordWin(winData) {
  try {
    let wins = [];
    if (fs.existsSync(WINS_FILE)) {
      try {
        wins = JSON.parse(fs.readFileSync(WINS_FILE, "utf-8"));
      } catch (_) {
        wins = [];
      }
    }

    const entry = {
      accountId: winData.accountId || "unknown",
      email: winData.email || "N/A",
      packTier: winData.packTier || "standard",
      brand: winData.brand || "N/A",
      denomination: winData.denomination || 0,
      codeOrUrl: winData.code || winData.codeOrUrl || "N/A",
      timestamp: new Date().toISOString(),
    };

    wins.push(entry);

    try {
      const tmpFile = `${WINS_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(wins, null, 2), "utf-8");
      fs.renameSync(tmpFile, WINS_FILE);
    } catch (_) {}

    console.log(`\n🎉 [WIN LOGGED] Account: ${entry.accountId} (${entry.email}) | ${entry.brand} $${entry.denomination}\n`);

    // Sync to Firestore Cloud collection 'yapcash_wins'
    logWinToFirestore(entry).catch((err) => {
      console.warn("⚠️ Failed to sync win to Firestore:", err.message);
    });

    // Dispatch instant Telegram notification (< 1s)
    sendWinAlert(entry).catch((err) => {
      console.warn("⚠️ Failed to dispatch Telegram win alert:", err.message);
    });

    return entry;
  } catch (err) {
    console.error("Failed to log win:", err.message);
  }
}

/**
 * Appends a pack opening transaction log to pack_history.json and Firestore cloud DB.
 */
function recordPackHistory(historyData) {
  try {
    let history = [];
    if (fs.existsSync(PACK_HISTORY_FILE)) {
      try {
        history = JSON.parse(fs.readFileSync(PACK_HISTORY_FILE, "utf-8"));
      } catch (_) {
        history = [];
      }
    }

    const entry = {
      timestamp: new Date().toISOString(),
      accountId: historyData.accountId || "unknown",
      email: historyData.email || "N/A",
      packTier: historyData.packTier || "standard",
      status: historyData.status || "unknown",
      xpAwarded: historyData.xpAwarded || 0,
      giftCard: historyData.giftCard || null,
      message: historyData.message || "",
      error: historyData.error || null,
    };

    history.push(entry);

    try {
      const tmpFile = `${PACK_HISTORY_FILE}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(history, null, 2), "utf-8");
      fs.renameSync(tmpFile, PACK_HISTORY_FILE);
    } catch (_) {}

    // Sync to Firestore Cloud collection 'yapcash_pack_history'
    logPackHistoryToFirestore(entry).catch((err) => {
      console.warn("⚠️ Failed to sync pack history to Firestore:", err.message);
    });

    return entry;
  } catch (err) {
    console.error("Failed to log pack history:", err.message);
  }
}

module.exports = {
  recordWin,
  recordPackHistory,
};


