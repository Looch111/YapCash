const fs = require("fs");
const path = require("path");

const ACCOUNTS_FILE = path.join(__dirname, "../accounts.json");
const EXAMPLE_FILE = path.join(__dirname, "../accounts.json.example");

const { syncAccountToFirestore, firestoreAccountsCache } = require("./firebaseClient");

/**
 * Loads accounts directly from in-memory Cloud Snapshot (synced live with Firebase Firestore).
 */
function loadAccounts() {
  if (firestoreAccountsCache && firestoreAccountsCache.size > 0) {
    const list = Array.from(firestoreAccountsCache.values());
    list.sort((a, b) => {
      const numA = parseInt((a.accountId || "").replace(/\D/g, ""), 10) || 0;
      const numB = parseInt((b.accountId || "").replace(/\D/g, ""), 10) || 0;
      return numA - numB;
    });
    return list;
  }

  let filePath = ACCOUNTS_FILE;
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const stripped = raw.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*/g, "$1");
      const parsed = JSON.parse(stripped);
      if (Array.isArray(parsed)) {
        parsed.forEach(acc => {
          if (acc.accountId) firestoreAccountsCache.set(acc.accountId, acc);
        });
        const list = Array.from(firestoreAccountsCache.values());
        list.sort((a, b) => {
          const numA = parseInt((a.accountId || "").replace(/\D/g, ""), 10) || 0;
          const numB = parseInt((b.accountId || "").replace(/\D/g, ""), 10) || 0;
          return numA - numB;
        });
        return list;
      }
    } catch (_) {}
  }

  return [];
}

/**
 * Saves updated account array to Firebase Firestore cloud store and memory cache.
 */
async function saveAccounts(accounts) {
  if (!Array.isArray(accounts)) return;
  for (const acc of accounts) {
    if (acc && acc.accountId) {
      firestoreAccountsCache.set(acc.accountId, acc);
      await syncAccountToFirestore(acc).catch(() => {});
    }
  }
}

const accountChangeListeners = [];

/**
 * Registers a callback to be notified whenever accounts are updated live.
 */
function onAccountsUpdated(listener) {
  if (typeof listener === "function") {
    accountChangeListeners.push(listener);
  }
}

/**
 * Notifies all registered account change listeners immediately.
 */
function notifyAccountChangeListeners(accounts) {
  const currentAccounts = accounts || loadAccounts();
  accountChangeListeners.forEach((listener) => {
    try { listener(currentAccounts); } catch (_) {}
  });
}

/**
 * Updates an account's persistent tokens deterministically by userId (sub), email, or accountId.
 * Synchronously awaits Firebase Firestore confirmation before returning accountId.
 */
async function updateAccountTokens(targetInfo, tokens = {}) {
  let accounts = loadAccounts();
  const searchId = typeof targetInfo === "string" ? targetInfo : targetInfo?.accountId;
  const searchEmail = typeof targetInfo === "object" ? targetInfo?.email : null;
  const searchUserId = typeof targetInfo === "object" ? targetInfo?.userId : null;

  const refreshToken = tokens.refreshToken || tokens.refresh_token || targetInfo?.refreshToken;
  const accessToken = tokens.accessToken || tokens.access_token || targetInfo?.accessToken;
  const email = searchEmail || tokens.email || tokens.user?.email || targetInfo?.email;
  const userId = searchUserId || tokens.userId || tokens.user?.id || tokens.user?.sub || targetInfo?.userId;

  let index = -1;

  // 1. Search by Supabase User ID (sub UUID)
  if (userId) {
    index = accounts.findIndex(acc => acc.userId && acc.userId === userId);
  }

  // 2. Search by Email (case-insensitive)
  if (index === -1 && email) {
    index = accounts.findIndex(acc => acc.email && acc.email.toLowerCase() === email.toLowerCase());
  }

  // 3. Search by Account ID (e.g. account_1)
  if (index === -1 && searchId && searchId !== "temp_sync") {
    index = accounts.findIndex(acc => acc.accountId === searchId);
  }

  // 4. Claim incomplete/empty account slot if available
  if (index === -1 && (email || userId)) {
    index = accounts.findIndex(acc => !acc.email || acc.email === "" || acc.email === "N/A");
  }

  let matchedId = searchId;
  let targetAccount = null;

  if (index !== -1) {
    matchedId = accounts[index].accountId;
    if (refreshToken) accounts[index].refreshToken = refreshToken;
    if (accessToken) accounts[index].accessToken = accessToken;
    if (email) accounts[index].email = email;
    if (userId) accounts[index].userId = userId;
    
    const orderNum = parseInt((matchedId || "").replace(/\D/g, ""), 10) || (index + 1);
    accounts[index].order = orderNum;
    targetAccount = accounts[index];

    console.log(`⚡ [AccountManager] Syncing cloud tokens to Firebase Firestore for ${matchedId} (${email || accounts[index].email})...`);
    await syncAccountToFirestore(accounts[index]);
  } else {
    // If searchId was explicitly provided (e.g. account_1), use searchId instead of refusing
    if (!email && !userId && !searchId) {
      console.warn("⚠️ [AccountManager] Refusing to register new account without resolved email or userId.");
      return null;
    }

    // SAFELY CREATE NEW ACCOUNT ENTRY (STRICT SEQUENTIAL NUMBERING: account_1, account_2, account_3...)
    const usedNums = accounts.map(a => parseInt((a.accountId || "").replace(/\D/g, ""), 10) || 0).filter(n => n > 0);
    const maxNum = usedNums.length > 0 ? Math.max(...usedNums) : 0;
    const nextNum = maxNum + 1;

    matchedId = `account_${nextNum}`;
    const orderNum = nextNum;

    // GEO-TARGETED PROXY POOLS (US accounts -> US proxies, UK accounts -> UK proxies)
    const GEO_PROXY_MAP = {
      US: [
        "http://jjhtjdhy:ffeb7qukj1lw@198.23.243.226:6361",
        "http://jjhtjdhy:ffeb7qukj1lw@38.154.185.97:6370",
        "http://jjhtjdhy:ffeb7qukj1lw@191.96.254.138:6185",
      ],
      GB: [
        "http://jjhtjdhy:ffeb7qukj1lw@31.59.20.176:6754",
        "http://jjhtjdhy:ffeb7qukj1lw@45.38.107.97:6014",
        "http://jjhtjdhy:ffeb7qukj1lw@198.105.121.200:6462",
      ],
      UK: [
        "http://jjhtjdhy:ffeb7qukj1lw@31.59.20.176:6754",
        "http://jjhtjdhy:ffeb7qukj1lw@45.38.107.97:6014",
        "http://jjhtjdhy:ffeb7qukj1lw@198.105.121.200:6462",
      ],
    };

    const countryCode = (targetInfo?.rewardCountry || targetInfo?.country || "US").toUpperCase();
    const geoPool = GEO_PROXY_MAP[countryCode] || GEO_PROXY_MAP["US"];
    const assignedProxy = targetInfo?.proxy || geoPool[(orderNum - 1) % geoPool.length];

    const newAcc = {
      accountId: matchedId,
      order: orderNum,
      refreshToken: refreshToken || "",
      accessToken: accessToken || "",
      email: email || "",
      userId: userId || "",
      proxy: assignedProxy,
      preferredBrand: "apple",
    };
    accounts.push(newAcc);
    targetAccount = newAcc;

    console.log(`✨ [AccountManager] Syncing new cloud account to Firebase Firestore: ${matchedId} (${email || "N/A"})...`);
    await syncAccountToFirestore(newAcc);
  }

  // Update in-memory snapshot
  if (targetAccount && targetAccount.accountId) {
    firestoreAccountsCache.set(targetAccount.accountId, targetAccount);
  }

  // Notify active daemon processes of live account list update
  accountChangeListeners.forEach(fn => {
    try { fn(accounts); } catch (_) {}
  });

  return matchedId;
}

const accountBalancesMemoryCache = new Map();

/**
 * Reads in-memory account balances snapshot.
 */
function loadAccountBalances() {
  const result = {};
  for (const [key, val] of accountBalancesMemoryCache.entries()) {
    result[key] = val;
  }
  return result;
}

/**
 * Saves updated account balances into RAM memory cache.
 */
function saveAccountBalances(balances) {
  if (balances && typeof balances === "object") {
    Object.keys(balances).forEach((id) => {
      accountBalancesMemoryCache.set(id, balances[id]);
    });
  }
}

/**
 * Updates a single account's RAM memory balance record.
 */
function updateSingleAccountBalance(accountId, data) {
  const existing = accountBalancesMemoryCache.get(accountId) || {};
  const updated = {
    ...existing,
    ...data,
    updatedAt: new Date().toISOString(),
  };
  accountBalancesMemoryCache.set(accountId, updated);
  return updated;
}

module.exports = {
  loadAccounts,
  saveAccounts,
  updateAccountTokens,
  onAccountsUpdated,
  notifyAccountChangeListeners,
  loadAccountBalances,
  saveAccountBalances,
  updateSingleAccountBalance,
};
