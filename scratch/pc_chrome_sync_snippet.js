(function () {
  const KOYEB_URL = "https://conservation-lory-agentdark-7e1cc3c7.koyeb.app/api/sync-token";
  const SYNC_SECRET = "yapcash_secret_2026";

  async function syncActiveToken() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
        console.warn("⚠️ Run this snippet inside Chrome DevTools (Extension Popup / Background Inspect page)");
        return;
      }

      chrome.storage.local.get(null, async (data) => {
        let refreshToken = data.refreshToken || (data.session && data.session.refresh_token) || null;
        let accessToken = data.accessToken || (data.session && data.session.access_token) || null;
        let email = data.email || null;
        let userId = data.userId || null;

        if (data["sb-gidoyrbvnffcwbzzweqb-auth-token"]) {
          try {
            const parsed = typeof data["sb-gidoyrbvnffcwbzzweqb-auth-token"] === "string" 
              ? JSON.parse(data["sb-gidoyrbvnffcwbzzweqb-auth-token"]) 
              : data["sb-gidoyrbvnffcwbzzweqb-auth-token"];
            
            if (parsed) {
              refreshToken = refreshToken || parsed.refresh_token || parsed.currentSession?.refresh_token;
              accessToken = accessToken || parsed.access_token || parsed.currentSession?.access_token;
              if (parsed.user) {
                email = email || parsed.user.email;
                userId = userId || parsed.user.id || parsed.user.sub;
              }
            }
          } catch (_) {}
        }

        if (!refreshToken && !accessToken) {
          console.warn("⚠️ No active YapCash token found in chrome.storage.local");
          return;
        }

        console.log("⚡ Found active session! Syncing live to Koyeb...");

        const response = await fetch(KOYEB_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-sync-key": SYNC_SECRET,
          },
          body: JSON.stringify({ refreshToken, accessToken, email, userId }),
        }).catch(err => ({ ok: false, statusText: err.message }));

        if (response.ok) {
          const resData = await response.json();
          console.log(`✅ [SUCCESS] Token auto-synced live to Koyeb for ${resData.accountId} (${resData.email})!`);
          try { alert(`🟢 Success! Token updated live on Koyeb for ${resData.accountId} (${resData.email})`); } catch (_) {}
        } else {
          console.error("❌ Token sync failed:", response.statusText || response.status);
        }
      });
    } catch (err) {
      console.error("❌ Sync Error:", err.message);
    }
  }

  syncActiveToken();

  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.refreshToken || changes.session || changes["sb-gidoyrbvnffcwbzzweqb-auth-token"]) {
        console.log("🔄 Detected YapCash account switch! Auto-syncing to Koyeb...");
        syncActiveToken();
      }
    });
    console.log("🟢 Live passive token listener ACTIVE in Chrome!");
  }
})();
