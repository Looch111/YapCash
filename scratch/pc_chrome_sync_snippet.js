(function () {
  // --------------------------------------------------------------------------
  // LOCAL PC SANDBOX vs CLOUD HOSTING CONFIGURATION:
  // For Local PC Sandbox mode: "http://localhost:8000/api/sync-token"
  // For Koyeb Cloud Hosting: "https://joyous-julietta-agentdark-531fbb1b.koyeb.app/api/sync-token"
  // --------------------------------------------------------------------------
  const SYNC_URL = "http://localhost:8000/api/sync-token";
  const SYNC_SECRET = "yapcash_secret_2026";

  function extractTokenFromObject(obj) {
    if (!obj || typeof obj !== "object") return null;
    let refreshToken = obj.refreshToken || obj.refresh_token || obj.currentSession?.refresh_token;
    let accessToken = obj.accessToken || obj.access_token || obj.currentSession?.access_token;
    let email = obj.email || obj.user?.email;
    let userId = obj.userId || obj.user?.id || obj.user?.sub;

    if (!refreshToken && obj.session) {
      refreshToken = obj.session.refresh_token || obj.session.refreshToken;
      accessToken = accessToken || obj.session.access_token || obj.session.accessToken;
      if (obj.session.user) {
        email = email || obj.session.user.email;
        userId = userId || obj.session.user.id || obj.session.user.sub;
      }
    }

    return (refreshToken || accessToken) ? { refreshToken, accessToken, email, userId } : null;
  }

  let lastSyncedTokenHash = "";
  let lastSyncTime = 0;

  async function syncActiveToken() {
    try {
      const now = Date.now();
      let data = {};
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        data = await new Promise(resolve => chrome.storage.local.get(null, resolve));
      }

      let extracted = extractTokenFromObject(data);

      if (!extracted || (!extracted.refreshToken && !extracted.accessToken)) {
        const allSources = [data];
        if (typeof window !== "undefined" && window.localStorage) {
          try {
            const localObj = {};
            for (let i = 0; i < window.localStorage.length; i++) {
              const k = window.localStorage.key(i);
              try { localObj[k] = JSON.parse(window.localStorage.getItem(k)); } catch (_) { localObj[k] = window.localStorage.getItem(k); }
            }
            allSources.push(localObj);
          } catch (_) { }
        }

        for (const source of allSources) {
          for (const key of Object.keys(source || {})) {
            const val = source[key];
            if (val && typeof val === "object") {
              const res = extractTokenFromObject(val);
              if (res && (res.refreshToken || res.accessToken)) {
                extracted = res;
                break;
              }
            } else if (typeof val === "string" && (val.includes("refresh_token") || val.includes("refreshToken") || val.includes("access_token"))) {
              try {
                const parsed = JSON.parse(val);
                const res = extractTokenFromObject(parsed);
                if (res && (res.refreshToken || res.accessToken)) {
                  extracted = res;
                  break;
                }
              } catch (_) { }
            }
          }
          if (extracted && (extracted.refreshToken || extracted.accessToken)) break;
        }
      }

      if (!extracted || (!extracted.refreshToken && !extracted.accessToken)) {
        console.warn("⚠️ No active session tokens found in Chrome storage. Please ensure you are logged into YapCash on Chrome.");
        return;
      }

      const currentHash = `${extracted.refreshToken || ""}:${extracted.accessToken || ""}:${extracted.email || ""}`;
      if (currentHash === lastSyncedTokenHash && (now - lastSyncTime < 30000)) {
        return; // Token unchanged and synced within last 30s (prevents double execution)
      }

      lastSyncedTokenHash = currentHash;
      lastSyncTime = now;

      console.log(`⚡ Found active session for ${extracted.email || "user"}! Syncing live to ${SYNC_URL}...`);

      const response = await fetch(SYNC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-sync-key": SYNC_SECRET,
        },
        body: JSON.stringify(extracted),
      }).catch(err => ({ ok: false, statusText: err.message }));

      if (response.ok) {
        const resData = await response.json();
        console.log(`✅ [SUCCESS] Token auto-synced live to sandbox/cloud for ${resData.accountId} (${resData.email})!`);
        try { alert(`🟢 Success! Token updated live for ${resData.accountId} (${resData.email})`); } catch (_) { }
      } else {
        const errJson = await response.json().catch(() => ({}));
        console.error(`❌ Token sync failed (HTTP ${response.status}):`, errJson.error || response.statusText);
      }
    } catch (err) {
      console.error("❌ Sync Error:", err.message);
    }
  }

  syncActiveToken();

  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.refreshToken || changes.accessToken || changes.session || changes["sb-gidoyrbvnffcwbzzweqb-auth-token"]) {
        syncActiveToken();
      }
    });
    console.log("🟢 Live passive token listener ACTIVE in Chrome!");
  }
})();

