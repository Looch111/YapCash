/**
 * ⚡ YapCash 1-Click Chrome Passive Token Sync Snippet (PC Browser)
 * 
 * Instructions:
 * 1. Open Chrome on your PC.
 * 2. Click the YapCash Extension icon -> Right-click & select "Inspect Popup" (or open Chrome DevTools console).
 * 3. Paste this code into the Console and hit Enter.
 * 4. Whenever you log in or switch accounts in the YapCash Chrome Extension, the active token is automatically sent to Koyeb!
 */

(function () {
  const KOYEB_URL = "https://yapcash-daemon.koyeb.app/api/sync-token"; // Replace with your exact Koyeb app URL
  const SYNC_SECRET = "yapcash_secret_2026";

  async function syncActiveToken() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
        console.warn("⚠️ Run this snippet inside Chrome DevTools (Extension Popup / Background Inspect page)");
        return;
      }

      chrome.storage.local.get(null, async (data) => {
        let refreshToken = null;
        if (data.session && data.session.refresh_token) {
          refreshToken = data.session.refresh_token;
        } else if (data["sb-gidoyrbvnffcwbzzweqb-auth-token"]) {
          try {
            const parsed = typeof data["sb-gidoyrbvnffcwbzzweqb-auth-token"] === "string" 
              ? JSON.parse(data["sb-gidoyrbvnffcwbzzweqb-auth-token"]) 
              : data["sb-gidoyrbvnffcwbzzweqb-auth-token"];
            refreshToken = parsed.refresh_token || parsed.currentSession?.refresh_token;
          } catch (_) {}
        }

        if (!refreshToken) {
          console.warn("⚠️ No active Supabase refresh token found in chrome.storage.local");
          return;
        }

        console.log("⚡ Found active refresh token! Syncing live to Koyeb...");

        const response = await fetch(KOYEB_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-sync-key": SYNC_SECRET,
          },
          body: JSON.stringify({ refreshToken }),
        }).catch(err => ({ ok: false, statusText: err.message }));

        if (response.ok) {
          const resData = await response.json();
          console.log(`✅ [SUCCESS] Token auto-synced live to Koyeb for ${resData.accountId} (${resData.email})!`);
          alert(`🟢 Success! Token updated live on Koyeb for ${resData.accountId} (${resData.email})`);
        } else {
          console.error("❌ Token sync failed:", response.statusText || response.status);
        }
      });
    } catch (err) {
      console.error("❌ Sync Error:", err.message);
    }
  }

  // Execute immediately
  syncActiveToken();

  // Listen for live storage updates when switching accounts in YapCash extension
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.session || changes["sb-gidoyrbvnffcwbzzweqb-auth-token"]) {
        console.log("🔄 Detected YapCash account switch! Auto-syncing to Koyeb...");
        syncActiveToken();
      }
    });
    console.log("🟢 Live passive token listener ACTIVE in Chrome!");
  }
})();
