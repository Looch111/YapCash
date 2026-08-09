const fs = require("fs");
const path = require("path");

const ACCOUNTS_FILE = path.join(__dirname, "../accounts.json");
const EXAMPLE_FILE = path.join(__dirname, "../accounts.json.example");

/**
 * Loads accounts from accounts.json. If missing, falls back to accounts.json.example.
 */
function loadAccounts() {
  let filePath = ACCOUNTS_FILE;
  if (!fs.existsSync(filePath)) {
    if (fs.existsSync(EXAMPLE_FILE)) {
      filePath = EXAMPLE_FILE;
    } else {
      return [];
    }
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    // Strip comments (// ... and /* ... */) so accounts.json can include comments freely
    const stripped = raw.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*/g, "$1");
    return JSON.parse(stripped);
  } catch (err) {
    console.error(`Failed to parse accounts file at ${filePath}:`, err.message);
    return [];
  }
}

/**
 * Saves updated account array back to accounts.json atomically.
 */
function saveAccounts(accounts) {
  const tmpFile = `${ACCOUNTS_FILE}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(accounts, null, 2), "utf-8");
    fs.renameSync(tmpFile, ACCOUNTS_FILE);
  } catch (err) {
    console.error(`Failed to save accounts file:`, err.message);
    if (fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }
}

/**
 * Updates a single account's persistent tokens.
 */
function updateAccountTokens(accountId, tokens) {
  const accounts = loadAccounts();
  const index = accounts.findIndex(acc => acc.accountId === accountId);
  if (index !== -1) {
    if (tokens.refreshToken) accounts[index].refreshToken = tokens.refreshToken;
    if (tokens.accessToken) accounts[index].accessToken = tokens.accessToken;
    saveAccounts(accounts);
  }
}

module.exports = {
  loadAccounts,
  saveAccounts,
  updateAccountTokens,
};
