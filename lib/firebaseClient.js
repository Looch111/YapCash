const { fetchWithRetry } = require("./http");

const FIREBASE_CONFIG = {
  apiKey: process.env.FIREBASE_API_KEY || "AIzaSyDvB-IZVAIFXbeKwHsn6DBcO_m65-Uv48E",
  authDomain: "telegram-mini-app-d28ab.firebaseapp.com",
  projectId: process.env.FIREBASE_PROJECT_ID || "telegram-mini-app-d28ab",
  storageBucket: "telegram-mini-app-d28ab.firebasestorage.app",
  messagingSenderId: "37701664057",
  appId: "1:37701664057:web:9bb71dc025d29ec7ce7ce8",
  measurementId: "G-K2GE50FVMP",
};

const DEFAULT_PROJECT_ID = FIREBASE_CONFIG.projectId;
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${DEFAULT_PROJECT_ID}/databases/(default)/documents`;

// In-memory Firestore cache map
let firestoreAccountsCache = new Map();
let isFirestoreConnected = false;

/**
 * Converts a plain JavaScript object to Firestore REST API field format.
 */
function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      fields[key] = { nullValue: null };
    } else if (typeof value === "boolean") {
      fields[key] = { booleanValue: value };
    } else if (typeof value === "number") {
      if (Number.isInteger(value)) {
        fields[key] = { integerValue: String(value) };
      } else {
        fields[key] = { doubleValue: value };
      }
    } else if (typeof value === "object") {
      fields[key] = { stringValue: JSON.stringify(value) };
    } else {
      fields[key] = { stringValue: String(value) };
    }
  }
  return fields;
}

/**
 * Converts Firestore REST API field format back to a plain JavaScript object.
 */
function fromFirestoreFields(fields) {
  if (!fields) return {};
  const obj = {};
  for (const [key, valObj] of Object.entries(fields)) {
    if ("stringValue" in valObj) {
      obj[key] = valObj.stringValue;
    } else if ("integerValue" in valObj) {
      obj[key] = parseInt(valObj.integerValue, 10);
    } else if ("doubleValue" in valObj) {
      obj[key] = parseFloat(valObj.doubleValue);
    } else if ("booleanValue" in valObj) {
      obj[key] = valObj.booleanValue;
    } else if ("nullValue" in valObj) {
      obj[key] = null;
    } else {
      obj[key] = Object.values(valObj)[0];
    }
  }
  return obj;
}

/**
 * Fetches all account documents from Firebase Firestore collection 'yapcash_accounts'.
 */
async function fetchAccountsFromFirestore() {
  try {
    const url = `${FIRESTORE_BASE_URL}/yapcash_accounts?pageSize=100`;
    const res = await fetchWithRetry(url, { method: "GET", timeout: 6000 }).catch(() => null);

    if (res && res.ok) {
      const data = await res.json();
      if (data.documents && Array.isArray(data.documents) && data.documents.length > 0) {
        const remoteMap = new Map();
        const accountsList = [];
        data.documents.forEach((doc) => {
          const accObj = fromFirestoreFields(doc.fields);
          if (accObj.accountId) {
            delete accObj._isPendingSync;
            remoteMap.set(accObj.accountId, accObj);
          }
        });

        // Update in-memory cache safely: merge remote items into cache
        remoteMap.forEach((val, key) => {
          firestoreAccountsCache.set(key, val);
        });

        // Remove cached accounts that no longer exist on Firestore, unless pending initial sync
        for (const [key, val] of firestoreAccountsCache.entries()) {
          if (!remoteMap.has(key) && !val._isPendingSync) {
            firestoreAccountsCache.delete(key);
          }
        }

        const sortedList = Array.from(firestoreAccountsCache.values());
        sortedList.sort((a, b) => {
          const numA = parseInt((a.accountId || "").replace(/\D/g, ""), 10) || 0;
          const numB = parseInt((b.accountId || "").replace(/\D/g, ""), 10) || 0;
          return numA - numB;
        });

        isFirestoreConnected = true;
        return sortedList;
      } else {
        // Cloud collection returned 0 documents: only clear cache if no pending sync items exist
        isFirestoreConnected = true;
        for (const [key, val] of firestoreAccountsCache.entries()) {
          if (!val._isPendingSync) {
            firestoreAccountsCache.delete(key);
          }
        }
        const remaining = Array.from(firestoreAccountsCache.values());
        remaining.sort((a, b) => {
          const numA = parseInt((a.accountId || "").replace(/\D/g, ""), 10) || 0;
          const numB = parseInt((b.accountId || "").replace(/\D/g, ""), 10) || 0;
          return numA - numB;
        });
        return remaining;
      }
    }
  } catch (err) {
    console.warn("⚠️ Firebase Firestore fetch warning:", err.message);
  }

  // Fallback to local memory cache if offline or unconfigured
  const cachedAccounts = Array.from(firestoreAccountsCache.values());
  cachedAccounts.sort((a, b) => {
    const numA = parseInt((a.accountId || "").replace(/\D/g, ""), 10) || 0;
    const numB = parseInt((b.accountId || "").replace(/\D/g, ""), 10) || 0;
    return numA - numB;
  });
  return cachedAccounts;
}

/**
 * Atomically upserts an account document in Firebase Firestore collection 'yapcash_accounts'.
 */
async function syncAccountToFirestore(accountData) {
  const accountId = accountData.accountId;
  if (!accountId) return false;

  const orderNum = parseInt((accountId || "").replace(/\D/g, ""), 10) || 0;

  // Update in-memory cache immediately with pending sync flag
  const existing = firestoreAccountsCache.get(accountId) || {};
  const merged = { ...existing, ...accountData, order: orderNum, updatedAt: new Date().toISOString() };
  merged._isPendingSync = true;
  firestoreAccountsCache.set(accountId, merged);

  try {
    const payloadFields = { ...merged };
    delete payloadFields._isPendingSync;

    const url = `${FIRESTORE_BASE_URL}/yapcash_accounts/${accountId}`;
    const payload = { fields: toFirestoreFields(payloadFields) };

    const res = await fetchWithRetry(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeout: 8000,
    }, 3, 500).catch(() => null);

    if (res && res.ok) {
      delete merged._isPendingSync;
      firestoreAccountsCache.set(accountId, merged);
      isFirestoreConnected = true;
      return true;
    }
  } catch (err) {
    console.warn(`⚠️ Firestore sync warning for ${accountId}:`, err.message);
  }

  return false;
}

/**
 * Deletes an account document from Firebase Firestore collection 'yapcash_accounts'.
 */
async function deleteAccountFromFirestore(accountId) {
  if (!accountId) return false;
  firestoreAccountsCache.delete(accountId);
  try {
    const url = `${FIRESTORE_BASE_URL}/yapcash_accounts/${accountId}`;
    const res = await fetchWithRetry(url, {
      method: "DELETE",
      timeout: 6000,
    }, 2, 500).catch(() => null);

    if (res && (res.ok || res.status === 404)) {
      isFirestoreConnected = true;
      return true;
    }
  } catch (err) {
    console.warn(`⚠️ Firestore delete warning for ${accountId}:`, err.message);
  }
  return false;
}

/**
 * Logs gift card wins and milestone events into Firestore collection 'yapcash_wins'.
 */
async function logWinToFirestore(winData) {
  try {
    const docId = `win_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const url = `${FIRESTORE_BASE_URL}/yapcash_wins/${docId}`;
    const payload = { fields: toFirestoreFields({ ...winData, timestamp: new Date().toISOString() }) };

    await fetchWithRetry(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeout: 4000,
    }).catch(() => null);
  } catch (_) {}
}

/**
 * Subscribes to real-time account updates via high-frequency background polling (<2s).
 */
function startFirestoreRealtimeListener(onAccountsUpdatedCallback, intervalMs = 2500) {
  setInterval(async () => {
    const freshAccounts = await fetchAccountsFromFirestore();
    if (typeof onAccountsUpdatedCallback === "function") {
      onAccountsUpdatedCallback(freshAccounts);
    }
  }, intervalMs);
}

/**
 * Returns whether Firebase Firestore is connected and active.
 */
function getFirestoreStatus() {
  return {
    connected: isFirestoreConnected,
    cachedCount: firestoreAccountsCache.size,
    projectId: DEFAULT_PROJECT_ID,
  };
}

module.exports = {
  fetchAccountsFromFirestore,
  syncAccountToFirestore,
  deleteAccountFromFirestore,
  logWinToFirestore,
  startFirestoreRealtimeListener,
  getFirestoreStatus,
  firestoreAccountsCache,
};
