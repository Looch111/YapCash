const fs = require("fs");
const path = require("path");

const WINS_FILE = path.join(__dirname, "../wins.json");

const { sendWinAlert } = require("./telegram");

/**
 * Appends a gift card win entry to wins.json and dispatches Telegram alert.
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
      codeOrUrl: winData.codeOrUrl || "N/A",
      timestamp: new Date().toISOString(),
    };

    wins.push(entry);

    const tmpFile = `${WINS_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(wins, null, 2), "utf-8");
    fs.renameSync(tmpFile, WINS_FILE);

    console.log(`\n🎉 [WIN LOGGED to wins.json] Account: ${entry.accountId} (${entry.email}) | ${entry.brand} $${entry.denomination}\n`);

    // Dispatch instant Telegram notification (< 1s)
    sendWinAlert(entry).catch((err) => {
      console.warn("⚠️ Failed to dispatch Telegram win alert:", err.message);
    });

    return entry;
  } catch (err) {
    console.error("Failed to log win to wins.json:", err.message);
  }
}

module.exports = {
  recordWin,
};
