const fs = require("fs");
const path = require("path");

const ACCOUNTS_FILE = path.join(__dirname, "../accounts.json");
const EXAMPLE_FILE = path.join(__dirname, "../accounts.json.example");

const { syncAccountToFirestore, firestoreAccountsCache } = require("./firebaseClient");

/**
 * Loads accounts directly from in-memory Cloud Snapshot (synced with Firebase Firestore).
 * Falls back to local disk accounts.json if Cloud snapshot is initializing.
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
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) {
      parsed.forEach(acc => {
        if (acc.accountId) firestoreAccountsCache.set(acc.accountId, acc);
      });
    }
    return parsed;
  } catch (err) {
    console.error(`Failed to parse accounts file at ${filePath}:`, err.message);
    return [];
  }
}

/**
 * Saves updated account array to Firebase Firestore cloud store and memory cache.
 */
function saveAccounts(accounts) {
  accounts.forEach(acc => {
    if (acc.accountId) {
      firestoreAccountsCache.set(acc.accountId, acc);
      syncAccountToFirestore(acc).catch(() => {});
    }
  });
}

const accountChangeListeners = [];

/**
 * Registers a callback to be notified whenever accounts.json is updated live.
 */
function onAccountsUpdated(listener) {
  if (typeof listener === "function") {
    accountChangeListeners.push(listener);
  }
}

/**
 * Updates an account's persistent tokens deterministically by userId (sub), email, or accountId.
 * If the account does not exist in accounts.json, it is safely appended as a new account entry (NEVER overwrites account_1!).
 */
function updateAccountTokens(targetInfo, tokens = {}) {
  let accounts = loadAccounts();
  const searchId = typeof targetInfo === "string" ? targetInfo : targetInfo?.accountId;
  const searchEmail = typeof targetInfo === "object" ? targetInfo?.email : null;
  const searchUserId = typeof targetInfo === "object" ? targetInfo?.userId : null;

  const refreshToken = tokens.refreshToken || targetInfo?.refreshToken;
  const accessToken = tokens.accessToken || targetInfo?.accessToken;
  const email = searchEmail || tokens.email;
  const userId = searchUserId || tokens.userId;

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

  if (index !== -1) {
    matchedId = accounts[index].accountId;
    if (refreshToken) accounts[index].refreshToken = refreshToken;
    if (accessToken) accounts[index].accessToken = accessToken;
    if (email) accounts[index].email = email;
    if (userId) accounts[index].userId = userId;
    
    // Attach order integer field
    const orderNum = parseInt((matchedId || "").replace(/\D/g, ""), 10) || (index + 1);
    accounts[index].order = orderNum;

    console.log(`⚡ [AccountManager] Updated cloud tokens for ${matchedId} (${email || accounts[index].email})`);
    syncAccountToFirestore(accounts[index]).catch(() => {});
  } else {
    // STRICT GUARD: Refuse to register a new account if email and userId are missing/unknown
    if (!email && !userId) {
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
        "http://bmrtynfq:cd2hv07lt0yr@38.154.185.97:6370",
        "http://fdkvfpmk:bsd6d7oqqn1u@31.59.20.176:6754",
        "http://fdkvfpmk:bsd6d7oqqn1u@45.38.107.97:6014",
        "http://fdkvfpmk:bsd6d7oqqn1u@198.105.121.200:6462",
        "http://bmrtynfq:cd2hv07lt0yr@198.23.243.226:6361",
      ],
      GB: [
        "http://212.58.132.5:8888",
      ],
      UK: [
        "http://212.58.132.5:8888",
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
    console.log(`✨ [AccountManager] Registered new cloud account: ${matchedId} (${email || "N/A"})`);
    syncAccountToFirestore(newAcc).catch(() => {});
  }

  saveAccounts(accounts);

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
  loadAccountBalances,
  saveAccountBalances,
  updateSingleAccountBalance,
};
