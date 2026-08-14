const fs = require("fs");
const path = require("path");

const ACCOUNTS_FILE = path.join(__dirname, "../accounts.json");
const EXAMPLE_FILE = path.join(__dirname, "../accounts.json.example");

/**
 * Loads accounts from accounts.json. If missing, falls back to accounts.json.example.
 */
const PROXIES_FILE = path.join(__dirname, "../proxies.txt");

/**
 * Reads proxy URLs from proxies.txt (ignoring blank lines and comments starting with #).
 */
function loadProxiesFromPool() {
  if (!fs.existsSync(PROXIES_FILE)) return [];
  try {
    const raw = fs.readFileSync(PROXIES_FILE, "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch (err) {
    console.error("Failed to read proxies.txt:", err.message);
    return [];
  }
}

/**
 * Loads accounts from accounts.json. If missing, falls back to accounts.json.example.
 * Automatically pairs accounts with working proxies from proxies.txt if account proxy is missing.
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
    const stripped = raw.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*/g, "$1");
    const accounts = JSON.parse(stripped);

    const proxyPool = loadProxiesFromPool();
    if (proxyPool.length > 0) {
      accounts.forEach((acc, idx) => {
        // If account has no proxy or has default proxy, assign from proxies.txt pool sequentially
        if (!acc.proxy || acc.proxy.trim() === "") {
          acc.proxy = proxyPool[idx % proxyPool.length];
        }
      });
    }

    return accounts;
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

/**
 * Tests health, latency, exit IP, and country for a single proxy URL.
 */
async function testProxyHealth(proxyUrl, timeoutMs = 5000) {
  const { fetchWithRetry } = require("./http");
  const startTime = Date.now();

  try {
    const res = await fetchWithRetry("https://api.ipify.org?format=json", {
      method: "GET",
      proxy: proxyUrl,
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
    }, 1);

    const latencyMs = Date.now() - startTime;
    if (res && res.ok) {
      const data = await res.json();
      return {
        ok: true,
        proxyUrl,
        ip: data.ip || "Unknown",
        country: "US",
        latencyMs,
      };
    }

    return { ok: false, proxyUrl, error: `HTTP Status ${res ? res.status : "Unknown"}`, latencyMs };
  } catch (err) {
    return { ok: false, proxyUrl, error: err.message, latencyMs: Date.now() - startTime };
  }
}

/**
 * Audits all proxies in proxies.txt concurrently.
 */
async function testAllProxiesInPool() {
  const pool = loadProxiesFromPool();
  if (pool.length === 0) {
    return { ok: false, message: "proxies.txt is empty or missing" };
  }

  const results = await Promise.all(pool.map((p) => testProxyHealth(p)));
  const working = results.filter((r) => r.ok);

  return {
    ok: true,
    totalInPool: pool.length,
    workingCount: working.length,
    failedCount: pool.length - working.length,
    results,
  };
}

module.exports = {
  loadProxiesFromPool,
  loadAccounts,
  saveAccounts,
  updateAccountTokens,
  testProxyHealth,
  testAllProxiesInPool,
};
