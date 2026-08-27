// ==UserScript==
// @name         YapCash Live Token Auto-Sync to Firebase
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Automatically sync active YapCash session tokens to Koyeb & Firebase Firestore 24/7 hands-free!
// @author       YapCash AutoFarm
// @match        http://*/*
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==UserScript==

(function () {
  'use strict';

  // 🟢 LOCALHOST SYNC URL (For local testing)
  const SYNC_URL = "http://localhost:3000/api/sync-token";
  // const SYNC_URL = "https://positive-lorinda-agentdark-2768a4b2.koyeb.app/api/sync-token"; // Koyeb Production URL
  const SYNC_SECRET = "yapcash_secret_2026";
  let lastSyncedToken = null;

  async function checkAndSyncToken() {
    try {
      // Read active Supabase auth token from localStorage
      let refreshToken = null;

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.includes("auth-token") || key.includes("supabase.auth"))) {
          try {
            const raw = localStorage.getItem(key);
            const parsed = JSON.parse(raw);
            refreshToken = parsed.refresh_token || parsed.currentSession?.refresh_token;
            if (refreshToken) break;
          } catch (_) {}
        }
      }

      if (!refreshToken) {
        refreshToken = localStorage.getItem("refreshToken") || localStorage.getItem("refresh_token");
      }

      if (refreshToken && refreshToken !== lastSyncedToken) {
        lastSyncedToken = refreshToken;
        console.log("⚡ [Tampermonkey] New token detected! Auto-syncing to Firebase Cloud...");

        if (typeof GM_xmlhttpRequest !== "undefined") {
          GM_xmlhttpRequest({
            method: "POST",
            url: KOYEB_URL,
            headers: {
              "Content-Type": "application/json",
              "x-sync-key": SYNC_SECRET,
            },
            data: JSON.stringify({ refreshToken }),
            onload: function (res) {
              if (res.status >= 200 && res.status < 300) {
                console.log("✅ [Tampermonkey] Token successfully auto-synced to Firebase!");
              }
            },
          });
        } else {
          fetch(KOYEB_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-sync-key": SYNC_SECRET },
            body: JSON.stringify({ refreshToken }),
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn("⚠️ Sync check error:", err.message);
    }
  }

  // Run on page load
  checkAndSyncToken();

  // Polling check every 5 seconds to detect account switching automatically
  setInterval(checkAndSyncToken, 5000);
})();
