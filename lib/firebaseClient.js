const fs = require("fs");
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
const FIREBASE_API_KEY = FIREBASE_CONFIG.apiKey;
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${DEFAULT_PROJECT_ID}/databases/(default)/documents`;

// In-memory Firestore cache map
let firestoreAccountsCache = new Map();
let isFirestoreConnected = false;

// Optional Firebase Admin SDK Initialization
let adminDb = null;
let adminInitializedAttempted = false;

function parseServiceAccountJson(inputStr) {
  if (!inputStr || typeof inputStr !== "string") return null;
  let raw = inputStr.trim();
  
  if (!raw.startsWith("{") && !fs.existsSync(raw)) {
    try {
      raw = Buffer.from(raw, "base64").toString("utf-8").trim();
    } catch (_) {}
  } else if (fs.existsSync(raw)) {
    try {
      raw = fs.readFileSync(raw, "utf-8").trim();
    } catch (_) {}
  }

  try {
    return JSON.parse(raw);
  } catch (err1) {
    try {
      const sanitized = raw.replace(/[\u0000-\u001F]+/g, (match) => {
        if (match.includes("\n")) return "\\n";
        if (match.includes("\r")) return "\\r";
        if (match.includes("\t")) return "\\t";
        return "";
      });
      return JSON.parse(sanitized);
    } catch (_) {
      throw err1;
    }
  }
}

function getAdminDb() {
  if (adminInitializedAttempted) return adminDb;
  adminInitializedAttempted = true;

  const envSa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!envSa) return null;

  try {
    const admin = require("firebase-admin");
    const saObj = parseServiceAccountJson(envSa);

    if (!saObj) return null;

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(saObj),
        projectId: saObj.project_id || DEFAULT_PROJECT_ID,
      });
    }

    adminDb = admin.firestore();
    isFirestoreConnected = true;
    console.log("🔥 [Firebase Admin SDK] Successfully initialized with Service Account credentials.");
    return adminDb;
  } catch (err) {
    console.warn("⚠️ [Firebase Admin SDK] Could not initialize Service Account:", err.message);
    adminDb = null;
    return null;
  }
}

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
      const strVal = valObj.stringValue;
      if (typeof strVal === "string" && (strVal.startsWith("{") || strVal.startsWith("["))) {
        try {
          obj[key] = JSON.parse(strVal);
        } catch (_) {
          obj[key] = strVal;
        }
      } else {
        obj[key] = strVal;
      }
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
 * Fetches all account documents from Firebase Firestore collection 'yapcash_accounts' with pagination.
 * Set forceRefresh = true to bypass memory cache and make a cloud network request.
 */
async function fetchAccountsFromFirestore(forceRefresh = false) {
  if (!forceRefresh && firestoreAccountsCache.size > 0) {
    const cachedAccounts = Array.from(firestoreAccountsCache.values());
    cachedAccounts.sort((a, b) => {
      const numA = parseInt((a.accountId || "").replace(/\D/g, ""), 10) || 0;
      const numB = parseInt((b.accountId || "").replace(/\D/g, ""), 10) || 0;
      return numA - numB;
    });
    return cachedAccounts;
  }

  const db = getAdminDb();
  if (db) {
    try {
      const snapshot = await db.collection("yapcash_accounts").get();
      const remoteMap = new Map();

      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data && data.accountId) {
          delete data._isPendingSync;
          remoteMap.set(data.accountId, data);
        }
      });

      remoteMap.forEach((val, key) => {
        firestoreAccountsCache.set(key, val);
      });

      for (const [key, val] of firestoreAccountsCache.entries()) {
        if (!remoteMap.has(key) && !val._isPendingSync) {
          firestoreAccountsCache.delete(key);
        }
      }

      isFirestoreConnected = true;
      const cachedAccounts = Array.from(firestoreAccountsCache.values());
      cachedAccounts.sort((a, b) => {
        const numA = parseInt((a.accountId || "").replace(/\D/g, ""), 10) || 0;
        const numB = parseInt((b.accountId || "").replace(/\D/g, ""), 10) || 0;
        return numA - numB;
      });
      return cachedAccounts;
    } catch (err) {
      console.warn("⚠️ Firebase Admin SDK fetch warning (falling back to REST API):", err.message);
      adminDb = null;
    }
  }

  // Fallback to REST API mode
  try {
    let allDocuments = [];
    let pageToken = null;
    let success = false;

    do {
      let url = `${FIRESTORE_BASE_URL}/yapcash_accounts?pageSize=100&key=${FIREBASE_API_KEY}`;
      if (pageToken) {
        url += `&pageToken=${encodeURIComponent(pageToken)}`;
      }

      const res = await fetchWithRetry(url, { method: "GET", timeout: 8000 }, 3, 800).catch(() => null);

      if (res && res.ok) {
        success = true;
        const data = await res.json();
        if (data.documents && Array.isArray(data.documents)) {
          allDocuments.push(...data.documents);
        }
        pageToken = data.nextPageToken || null;
      } else {
        break;
      }
    } while (pageToken);

    if (success) {
      const remoteMap = new Map();
      allDocuments.forEach((doc) => {
        const accObj = fromFirestoreFields(doc.fields);
        if (accObj.accountId) {
          delete accObj._isPendingSync;
          remoteMap.set(accObj.accountId, accObj);
        }
      });

      remoteMap.forEach((val, key) => {
        firestoreAccountsCache.set(key, val);
      });

      for (const [key, val] of firestoreAccountsCache.entries()) {
        if (!remoteMap.has(key) && !val._isPendingSync) {
          firestoreAccountsCache.delete(key);
        }
      }

      isFirestoreConnected = true;
    }
  } catch (err) {
    console.warn("⚠️ Firebase Firestore REST fetch warning:", err.message);
  }

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

  const existing = firestoreAccountsCache.get(accountId) || {};
  const merged = { ...existing, ...accountData, order: orderNum, updatedAt: new Date().toISOString() };
  merged._isPendingSync = true;
  firestoreAccountsCache.set(accountId, merged);

  const db = getAdminDb();
  if (db) {
    try {
      const payloadFields = { ...merged };
      delete payloadFields._isPendingSync;
      await db.collection("yapcash_accounts").doc(accountId).set(payloadFields, { merge: true });
      delete merged._isPendingSync;
      firestoreAccountsCache.set(accountId, merged);
      isFirestoreConnected = true;
      return true;
    } catch (err) {
      console.warn(`⚠️ Firebase Admin SDK sync warning for ${accountId}:`, err.message);
    }
  }

  // Fallback to REST API
  try {
    const payloadFields = { ...merged };
    delete payloadFields._isPendingSync;

    const url = `${FIRESTORE_BASE_URL}/yapcash_accounts/${accountId}?key=${FIREBASE_API_KEY}`;
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
    console.warn(`⚠️ Firestore REST sync warning for ${accountId}:`, err.message);
  }

  return false;
}

/**
 * Deletes an account document from Firebase Firestore collection 'yapcash_accounts'.
 */
async function deleteAccountFromFirestore(accountId) {
  if (!accountId) return false;
  firestoreAccountsCache.delete(accountId);

  const db = getAdminDb();
  if (db) {
    try {
      await db.collection("yapcash_accounts").doc(accountId).delete();
      isFirestoreConnected = true;
      return true;
    } catch (err) {
      console.warn(`⚠️ Firebase Admin SDK delete warning for ${accountId}:`, err.message);
    }
  }

  try {
    const url = `${FIRESTORE_BASE_URL}/yapcash_accounts/${accountId}?key=${FIREBASE_API_KEY}`;
    const res = await fetchWithRetry(url, {
      method: "DELETE",
      timeout: 6000,
    }, 2, 500).catch(() => null);

    if (res && (res.ok || res.status === 404)) {
      isFirestoreConnected = true;
      return true;
    }
  } catch (err) {
    console.warn(`⚠️ Firestore REST delete warning for ${accountId}:`, err.message);
  }
  return false;
}

/**
 * Logs gift card wins into Firestore collection 'yapcash_wins'.
 */
async function logWinToFirestore(winData) {
  const docId = `win_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const payload = { ...winData, timestamp: new Date().toISOString() };

  const db = getAdminDb();
  if (db) {
    try {
      await db.collection("yapcash_wins").doc(docId).set(payload);
      return;
    } catch (_) {}
  }

  try {
    const url = `${FIRESTORE_BASE_URL}/yapcash_wins/${docId}?key=${FIREBASE_API_KEY}`;
    const restPayload = { fields: toFirestoreFields(payload) };

    await fetchWithRetry(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(restPayload),
      timeout: 4000,
    }).catch(() => null);
  } catch (_) {}
}

/**
 * Logs pack history transactions into Firestore collection 'yapcash_pack_history'.
 */
async function logPackHistoryToFirestore(historyData) {
  const docId = `history_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const payload = { ...historyData, timestamp: new Date().toISOString() };

  const db = getAdminDb();
  if (db) {
    try {
      await db.collection("yapcash_pack_history").doc(docId).set(payload);
      return;
    } catch (_) {}
  }

  try {
    const url = `${FIRESTORE_BASE_URL}/yapcash_pack_history/${docId}?key=${FIREBASE_API_KEY}`;
    const restPayload = { fields: toFirestoreFields(payload) };

    await fetchWithRetry(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(restPayload),
      timeout: 4000,
    }).catch(() => null);
  } catch (_) {}
}

/**
 * Syncs Telegram state (active routine messages, unconfirmed gift card alerts) to Firestore.
 */
async function syncTelegramStateToFirestore(telegramState) {
  const payload = { ...telegramState, updatedAt: new Date().toISOString() };

  const db = getAdminDb();
  if (db) {
    try {
      await db.collection("yapcash_telegram_state").doc("current_state").set(payload, { merge: true });
      return true;
    } catch (_) {}
  }

  try {
    const url = `${FIRESTORE_BASE_URL}/yapcash_telegram_state/current_state?key=${FIREBASE_API_KEY}`;
    const restPayload = { fields: toFirestoreFields(payload) };

    const res = await fetchWithRetry(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(restPayload),
      timeout: 5000,
    }, 2, 500).catch(() => null);

    return Boolean(res && res.ok);
  } catch (_) {
    return false;
  }
}

/**
 * Fetches Telegram state from Firestore.
 */
async function fetchTelegramStateFromFirestore() {
  const db = getAdminDb();
  if (db) {
    try {
      const doc = await db.collection("yapcash_telegram_state").doc("current_state").get();
      if (doc.exists) return doc.data();
    } catch (_) {}
  }

  try {
    const url = `${FIRESTORE_BASE_URL}/yapcash_telegram_state/current_state?key=${FIREBASE_API_KEY}`;
    const res = await fetchWithRetry(url, { method: "GET", timeout: 5000 }, 2, 500).catch(() => null);

    if (res && res.ok) {
      const data = await res.json();
      if (data && data.fields) {
        return fromFirestoreFields(data.fields);
      }
    }
  } catch (_) {}
  return null;
}

let lastKnownAccountsSignature = "";

/**
 * Subscribes to real-time account updates via Firebase Admin SDK or high-frequency background polling (<2s).
 */
function startFirestoreRealtimeListener(onAccountsUpdatedCallback, intervalMs = 2000) {
  const db = getAdminDb();
  if (db) {
    console.log("⚡ [Firebase Admin SDK] Subscribing to real-time Firestore snapshot listener on 'yapcash_accounts'...");
    db.collection("yapcash_accounts").onSnapshot(
      (snapshot) => {
        const remoteMap = new Map();
        snapshot.forEach((doc) => {
          const data = doc.data();
          if (data && data.accountId) {
            remoteMap.set(data.accountId, data);
          }
        });

        remoteMap.forEach((val, key) => firestoreAccountsCache.set(key, val));
        for (const [key, val] of firestoreAccountsCache.entries()) {
          if (!remoteMap.has(key) && !val._isPendingSync) {
            firestoreAccountsCache.delete(key);
          }
        }
        isFirestoreConnected = true;

        const freshAccounts = Array.from(firestoreAccountsCache.values());
        freshAccounts.sort((a, b) => {
          const numA = parseInt((a.accountId || "").replace(/\D/g, ""), 10) || 0;
          const numB = parseInt((b.accountId || "").replace(/\D/g, ""), 10) || 0;
          return numA - numB;
        });

        const currentSignature = JSON.stringify(
          freshAccounts.map(a => `${a.accountId}:${a.refreshToken}:${a.email}:${a.status}:${a.proxy}:${a.totalXp}:${a.streak}:${a.lastRunAt}:${a.updatedAt}:${a.error}`)
        );

        if (currentSignature !== lastKnownAccountsSignature) {
          const isInitial = lastKnownAccountsSignature === "";
          lastKnownAccountsSignature = currentSignature;
          if (!isInitial && typeof onAccountsUpdatedCallback === "function") {
            onAccountsUpdatedCallback(freshAccounts);
          }
        }
      },
      (err) => {
        console.warn("⚠️ [Firebase Admin Realtime Listener Error] Falling back to REST API listener:", err.message);
        adminDb = null;
        startFirestoreRealtimeListener(onAccountsUpdatedCallback, intervalMs);
      }
    );
    return;
  }

  // REST API polling mode (5-minute pulse interval to protect Firebase 50k daily read quota)
  const pollDelay = Math.max(60000, intervalMs); // Minimum 60s safety limit
  setInterval(async () => {
    const freshAccounts = await fetchAccountsFromFirestore(true); // Force cloud refresh every 5 mins
    const currentSignature = JSON.stringify(
      freshAccounts.map(a => `${a.accountId}:${a.refreshToken}:${a.email}:${a.status}:${a.proxy}:${a.totalXp}:${a.streak}:${a.lastRunAt}:${a.updatedAt}:${a.error}`)
    );

    if (currentSignature !== lastKnownAccountsSignature) {
      const isInitial = lastKnownAccountsSignature === "";
      lastKnownAccountsSignature = currentSignature;

      if (!isInitial) {
        console.log(`⚡ [Firebase Listener] Live Firestore Cloud DB pulse update detected (${freshAccounts.length} accounts)!`);
        if (typeof onAccountsUpdatedCallback === "function") {
          onAccountsUpdatedCallback(freshAccounts);
        }
      }
    }
  }, pollDelay);
}

/**
 * Returns whether Firebase Firestore is connected and active.
 */
function getFirestoreStatus() {
  return {
    connected: isFirestoreConnected,
    mode: adminDb ? "firebase-admin" : "rest-api",
    cachedCount: firestoreAccountsCache.size,
    projectId: DEFAULT_PROJECT_ID,
  };
}

module.exports = {
  fetchAccountsFromFirestore,
  syncAccountToFirestore,
  deleteAccountFromFirestore,
  logWinToFirestore,
  logPackHistoryToFirestore,
  syncTelegramStateToFirestore,
  fetchTelegramStateFromFirestore,
  startFirestoreRealtimeListener,
  getFirestoreStatus,
  firestoreAccountsCache,
};
