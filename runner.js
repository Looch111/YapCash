const { loadAccounts, saveAccounts, updateAccountTokens, updateAccountState, updateAccountStatus, ACCOUNT_STATUS } = require("./lib/accountManager");
const SupabaseClient = require("./lib/supabaseClient");
const { runFullDailyRoutine, claimDailyBonus, claimDailySpin, claimWeekBonusCalendar, recoverUnclaimedGiftCards, syncXp, openRewardPack } = require("./lib/apiTasks");
const { sendDailyReport, sendAccountReport, cleanupPreviousRoutineMessages, startTelegramPollingListener, initTelegramStateFromFirestore } = require("./lib/telegram");

// Global in-memory set to prevent duplicate processing on the same account concurrently
const activeProcessingLocks = new Set();

// Shared live state tracking for Telegram bot status rendering
const liveDaemonState = {
  currentlyRunningAccountId: null,
  nextScheduledAccountId: null,
  nextScheduledTimeMs: null,
};

function getLiveDaemonState() {
  return liveDaemonState;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "daemon";

  const { fetchAccountsFromFirestore } = require("./lib/firebaseClient");
  let accounts = await fetchAccountsFromFirestore();
  if (accounts.length === 0) {
    accounts = loadAccounts();
  }

  if (accounts.length === 0 && command !== "daemon" && command !== "audit") {
    console.error("❌ No accounts found in Firebase Firestore Cloud DB. Please run daemon mode or sync tokens via HTTP API.");
    process.exit(1);
  }

  switch (command) {
    case "daemon":
      await runDaemonMode(accounts);
      break;

    case "audit":
      require("./scratch/master_system_audit.js");
      break;

    case "status":
      await showStatus(accounts);
      break;

    case "run-all":
      await runAllAccounts(accounts);
      break;

    case "run": {
      const targetId = args[1];
      if (!targetId) {
        console.error("❌ Usage: node runner.js run <accountId>");
        process.exit(1);
      }
      await runSingleAccount(accounts, targetId);
      break;
    }

    case "spin":
      await runTaskForAccounts(accounts, args[1], claimDailySpin, "Daily Spin");
      break;

    case "bonus":
      await runTaskForAccounts(accounts, args[1], claimDailyBonus, "Daily Bonus");
      break;

    case "week-bonus": {
      const day = args[2] ? parseInt(args[2], 10) : null;
      await runTaskForAccounts(accounts, args[1], (client) => claimWeekBonusCalendar(client, day), "Weekly Bonus Calendar");
      break;
    }

    case "recover-cards":
      await runTaskForAccounts(accounts, args[1], (client) => recoverUnclaimedGiftCards(client), "Gift Card Recovery");
      break;

    case "sync": {
      const xpAmount = parseInt(args[2] || "15", 10);
      await runTaskForAccounts(accounts, args[1], (client) => syncXp(client, xpAmount), `XP Sync (${xpAmount} XP)`);
      break;
    }

    case "open-pack": {
      const packId = args[2] || "standard";
      await runTaskForAccounts(accounts, args[1], (client) => openRewardPack(client, packId), `Open Pack (${packId})`);
      break;
    }

    case "smart-drain":
      const { drainAccountPacks } = require("./lib/apiTasks");
      await runTaskForAccounts(accounts, args[1], (client) => drainAccountPacks(client, 10), "Smart Waterfall Auto-Drain");
      break;

    case "help":
    default:
      printHelp();
      break;
  }
}

/**
 * Calculates milliseconds until next UTC Midnight reset (+ 5 min buffer at 00:05 UTC).
 */
function getMsUntilNextUtcReset() {
  const now = new Date();
  const nextReset = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 5, 0 // 00:05:00 UTC
  ));
  return Math.max(10000, nextReset.getTime() - now.getTime());
}

/**
 * Formats milliseconds into human-readable duration (e.g. "10h 32m 15s").
 */
function formatDuration(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  return `${hours}h ${minutes}m ${seconds}s`;
}

/**
 * Fast parallel token validation scan for all registered accounts on startup / cycle init.
 * Immediately dispatches Telegram alerts for any expired tokens.
 */
async function validateAccountsTokenStatus(accounts, options = {}) {
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  const silent = options.silent === true;
  console.log(`🔍 [Token Audit Engine] Performing fast parallel token validation on ${accounts.length} account(s)...`);

  const { sendTokenExpiredAlert } = require("./lib/telegram");

  const results = await Promise.all(
    accounts.map(async (acc) => {
      // Don't override PAUSED or STOPPED manual states
      if (acc.status === ACCOUNT_STATUS.PAUSED || acc.status === ACCOUNT_STATUS.STOPPED) {
        return { ok: false, accountId: acc.accountId, status: acc.status };
      }

      const client = new SupabaseClient(acc);
      try {
        const session = await Promise.race([
          client.ensureAuthenticated(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Auth check timeout (5s)")), 5000)),
        ]);

        if (session && session.accessToken) {
          if (session.accessToken !== acc.accessToken || session.refreshToken !== acc.refreshToken) {
            await updateAccountTokens(acc, session).catch(() => {});
          }
          return { ok: true, accountId: acc.accountId };
        }
        throw new Error("Invalid session format");
      } catch (err) {
        console.warn(`  ⚠️ Token validation failed for ${acc.accountId} (${acc.email || "N/A"}): ${err.message}`);
        acc.status = ACCOUNT_STATUS.FAILED;
        await updateAccountStatus(acc.accountId, ACCOUNT_STATUS.FAILED, err.message).catch(() => {});
        if (!silent) {
          await sendTokenExpiredAlert(acc.accountId, acc.email, err.message).catch(() => {});
        }
        return { ok: false, accountId: acc.accountId, error: err.message };
      }
    })
  );

  const working = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`✅ [Token Audit Engine] Scan complete: ${working} Active & Ready | ⚠️ ${failed} Expired/Disabled`);

  return results;
}

/**
 * Continuous 24-hour randomized staggered daemon scheduler loop.
 * Integrates persistent state recovery, real-time sync, and duplicate processing locks.
 */
async function runDaemonMode(initialAccounts) {
  // Start HTTP API server for Koyeb cloud platform & remote passive token sync
  try {
    const http = require("http");
    const PORT = process.env.PORT || 8000;
    const SYNC_SECRET = process.env.SYNC_SECRET || "yapcash_secret_2026";

    http.createServer(async (req, res) => {
      // Set CORS headers so Chrome browser on PC can send token POST requests smoothly
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-sync-key");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }

      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      // 1. Health check GET endpoint
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "online", daemon: "active", scheduler: "24h_staggered", timestamp: new Date().toISOString() }));
      }

      // 2. Passive Token Sync POST endpoint
      if (req.method === "POST" && url.pathname === "/api/sync-token") {
        let body = "";
        let bodySize = 0;
        req.on("data", chunk => {
          bodySize += chunk.length;
          if (bodySize > 100 * 1024) {
            req.destroy();
            res.writeHead(413, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: "Payload Too Large (>100KB)" }));
          }
          body += chunk;
        });

        req.on("end", async () => {
          try {
            const data = JSON.parse(body || "{}");
            const keyProvided = req.headers["x-sync-key"] || data.secretKey || data.key;

            if (keyProvided !== SYNC_SECRET) {
              res.writeHead(401, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ ok: false, error: "Unauthorized: Invalid secret key" }));
            }

            const refreshToken = data.refreshToken || data.refresh_token || null;
            const accessToken = data.accessToken || data.access_token || null;

            if (!refreshToken && !accessToken) {
              console.warn("⚠️ [Passive Sync 400] Missing both refreshToken and accessToken in request body.");
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ ok: false, error: "Missing session tokens (both refreshToken and accessToken missing)" }));
            }

            let activeAccessToken = accessToken;
            let activeRefreshToken = refreshToken;
            let email = data.email || null;
            let userId = data.userId || null;
            let rewardCountry = "US";
            let userState = null;

            // 1. Fast 0ms JWT decoding for valid accessTokens (bypasses network delays)
            if (activeAccessToken) {
              try {
                const payloadBase64 = activeAccessToken.split(".")[1];
                const decoded = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf-8"));
                const nowSec = Math.floor(Date.now() / 1000);
                if (decoded.exp && decoded.exp > nowSec + 30) {
                  email = email || decoded.email || decoded.user_metadata?.email || null;
                  userId = userId || decoded.sub || null;
                }
              } catch (_) {}
            }

            // 2. Fallback to network authentication if JWT was expired or unparseable
            if (!email || !userId) {
              const tempAcc = { accountId: "temp_sync", refreshToken: activeRefreshToken, accessToken: activeAccessToken, proxy: null };
              const client = new SupabaseClient(tempAcc);
              const session = await client.ensureAuthenticated().catch(err => ({ error: err.message }));

              if (!session || !session.accessToken) {
                console.warn(`⚠️ [Passive Sync 400] Supabase Auth Failed: ${session?.error || "Invalid/Expired session tokens"}`);
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ ok: false, error: `Invalid session tokens: ${session?.error || "Auth failed"}` }));
              }

              activeAccessToken = session.accessToken;
              activeRefreshToken = session.refreshToken || activeRefreshToken;
              email = session.user?.email || email;
              userId = session.user?.id || session.user?.sub || userId;

              userState = await client.getUserState().catch(() => null);
              if (userState && userState.reward_country) rewardCountry = userState.reward_country;
            }

            const targetId = await updateAccountTokens({
              accountId: data.accountId,
              email,
              userId,
              refreshToken: activeRefreshToken,
              accessToken: activeAccessToken,
              rewardCountry,
            });

            if (!targetId) {
              res.writeHead(503, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ ok: false, error: "Cloud DB unverified or unable to update tokens" }));
            }

            console.log(`⚡ [Passive Sync] Token updated & persisted to Firebase for ${targetId} (${email || "N/A"})`);

            const accEntry = {
              accountId: targetId,
              email: email || "N/A",
              rewardCountry: rewardCountry || "US",
              totalXp: userState?.total_xp ?? "N/A",
              streak: userState?.current_streak ?? "N/A",
            };

            // Dispatch Telegram notification card for live token sync
            const { sendTokenUpdateNotification } = require("./lib/telegram");
            await sendTokenUpdateNotification(accEntry).catch((err) => {
              console.warn("⚠️ Could not send token sync Telegram notification:", err.message);
            });

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
              ok: true,
              accountId: targetId,
              email: email || "N/A",
              message: `Token updated live on Koyeb and persisted to Firebase for ${targetId}!`,
            }));
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // 3. Server Process Reboot POST endpoint
      if (req.method === "POST" && url.pathname === "/api/restart") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Koyeb server process rebooting..." }));
        console.log("🔄 HTTP /api/restart endpoint called. Rebooting container in 1s...");
        setTimeout(() => process.exit(0), 1000);
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Endpoint not found" }));
    }).listen(PORT, () => {
      console.log(`🌐 Health check & Passive Token Sync API server active on port ${PORT}`);
      const serverUrl = process.env.SERVER_URL || process.env.KOYEB_APP_URL || process.env.RENDER_EXTERNAL_URL;
      if (serverUrl) {
        const keepAliveUrl = `${serverUrl.replace(/\/$/, "")}/health`;
        setInterval(() => {
          try {
            const { fetchWithRetry } = require("./lib/http");
            fetchWithRetry(keepAliveUrl, { method: "GET" }, 1, 3000).catch(() => {});
          } catch (_) {}
        }, 5 * 60 * 1000);
        console.log(`💓 [Keep-Alive Engine] Self-ping active every 5m to ${keepAliveUrl}`);
      }
    });
  } catch (err) {
    console.warn("⚠️ Could not start HTTP server:", err.message);
  }

  // Initialize Telegram state from Firestore first
  await initTelegramStateFromFirestore().catch(() => {});

  // Initialize Firebase Firestore Cloud Hydration & Realtime Listener
  const { startFirestoreRealtimeListener, fetchAccountsFromFirestore } = require("./lib/firebaseClient");
  const { onAccountsUpdated, notifyAccountChangeListeners } = require("./lib/accountManager");

  console.log("⚡ Hydrating Firestore accounts from Firebase Cloud DB...");
  let bootAccounts = await fetchAccountsFromFirestore().catch(() => []);
  
  // Retry up to 10 times (10s total) on cloud container startup to allow network initialization
  let attempts = 0;
  while ((!bootAccounts || bootAccounts.length === 0) && attempts < 10) {
    attempts++;
    await new Promise((r) => setTimeout(r, 1000));
    bootAccounts = await fetchAccountsFromFirestore().catch(() => []);
  }

  // Account State Recovery on Startup
  const todayUtcStr = new Date().toISOString().split("T")[0];
  if (bootAccounts && bootAccounts.length > 0) {
    console.log(`✅ [Firestore Hydration] Successfully loaded ${bootAccounts.length} account(s) from Cloud DB.`);
    for (const acc of bootAccounts) {
      const lastRunDate = acc.lastRunAt ? new Date(acc.lastRunAt).toISOString().split("T")[0] : null;
      if (lastRunDate === todayUtcStr && acc.status === ACCOUNT_STATUS.COMPLETED) {
        // Account already completed today
        acc.status = ACCOUNT_STATUS.COMPLETED;
      } else if (acc.status === ACCOUNT_STATUS.PAUSED || acc.status === ACCOUNT_STATUS.STOPPED) {
        // Retain manual paused/stopped state
      } else {
        // Pending or interrupted active run -> mark PENDING
        acc.status = ACCOUNT_STATUS.PENDING;
      }
      await updateAccountStatus(acc.accountId, acc.status).catch(() => {});
    }

    // Perform Fast Parallel Token Audit Scan on Startup (silent mode - consolidated into single boot card)
    await validateAccountsTokenStatus(bootAccounts, { silent: true });
  } else {
    console.log("ℹ️ [Firestore Hydration] 0 accounts found in Cloud DB. Engine active in passive waiting mode.");
  }

  startFirestoreRealtimeListener((freshAccounts) => {
    notifyAccountChangeListeners(freshAccounts);
    try {
      const telegram = require("./lib/telegram");
      if (telegram && typeof telegram.updateLiveTelegramMenu === "function") {
        telegram.updateLiveTelegramMenu(freshAccounts).catch(() => {});
      }
    } catch (_) {}
  }, 300000);

  // Start background Telegram listener for 24/7 interactive pack commands & button polling
  startTelegramPollingListener();

  // Send automatic Server Boot Notification to Telegram on startup
  const { sendServerBootNotification } = require("./lib/telegram");
  await sendServerBootNotification(bootAccounts || []).catch((err) => {
    console.warn("⚠️ Could not send server boot Telegram notification:", err.message);
  });

  let tokenSignalResolver = null;
  onAccountsUpdated(() => {
    if (typeof tokenSignalResolver === "function") {
      console.log("⚡ [Daemon Engine] Account list change signal received. Rescaling schedule live...");
      tokenSignalResolver();
      tokenSignalResolver = null;
    }
  });

  let initialBannerPrinted = false;
  let cycleCount = 1;

  while (true) {
    const allAccounts = loadAccounts(); // reload fresh accounts list
    if (!allAccounts || allAccounts.length === 0) {
      if (!initialBannerPrinted) {
        console.log("\n=======================================================");
        console.log(" ⚡ YAPCASH CLOUD ENGINE ACTIVE & WAITING FOR TOKENS");
        console.log("=======================================================");
        console.log(` 🌐 HTTP Token Sync API : PORT ${process.env.PORT || 8000} (Active)`);
        console.log(` 📱 Telegram Control Bot: Active`);
        console.log(` 🔥 Firebase Store      : 0 Accounts Registered`);
        console.log("-------------------------------------------------------");
        console.log(" 🟢 System online. Passively waiting for Chrome tokens...");
        console.log("=======================================================\n");
        initialBannerPrinted = true;
      }

      await new Promise(resolve => {
        tokenSignalResolver = resolve;
        setTimeout(resolve, 30000);
      });
      continue;
    }

    initialBannerPrinted = false;

    // Filter accounts eligible for execution (PENDING active accounts only - FAILED/EXPIRED tokens are skipped until hot-synced)
    const eligibleAccounts = allAccounts.filter(a => a.status === ACCOUNT_STATUS.PENDING || !a.status);

    if (eligibleAccounts.length === 0) {
      console.log(`\n🎉 [All Accounts Completed] All ${allAccounts.length} account(s) have completed routines for today.`);
      const msUntilReset = getMsUntilNextUtcReset();
      const formattedResetTime = formatDuration(msUntilReset);
      const targetResetTimestamp = Date.now() + msUntilReset;
      console.log(`🌙 Sleeping ${formattedResetTime} until 00:05 UTC reset...`);

      await new Promise((resolve) => {
        tokenSignalResolver = resolve;
        setTimeout(resolve, msUntilReset);
      });

      const isMidnightReached = Date.now() >= (targetResetTimestamp - 5000);

      if (isMidnightReached) {
        console.log(`\n🌅 [00:05 UTC Reset] Resetting account status to PENDING for the new day...`);
        const resetAccounts = loadAccounts();
        for (const acc of resetAccounts) {
          if (acc.status !== ACCOUNT_STATUS.PAUSED && acc.status !== ACCOUNT_STATUS.STOPPED) {
            await updateAccountStatus(acc.accountId, ACCOUNT_STATUS.PENDING).catch(() => {});
          }
        }
        cycleCount++;
      } else {
        console.log(`ℹ️ [Daemon Engine] Token signal received during sleep. Checking for newly added PENDING accounts...`);
      }
      continue;
    }

    console.log(`\n⏰ [Cycle #${cycleCount}] Distributing ${eligibleAccounts.length}/${allAccounts.length} eligible accounts across 24 hours...`);

    const daemonReportAccounts = [];
    const shuffledAccounts = [...eligibleAccounts].sort(() => Math.random() - 0.5);

    const totalDayMs = 24 * 60 * 60 * 1000;
    const baseSlotMs = Math.floor(totalDayMs / Math.max(1, shuffledAccounts.length));

    for (let i = 0; i < shuffledAccounts.length; i++) {
      const baseAcc = shuffledAccounts[i];
      const freshAccounts = loadAccounts();
      const acc = freshAccounts.find(a => a.accountId === baseAcc.accountId) || baseAcc;

      // Skip if account was paused, stopped, or completed during cycle
      if (acc.status === ACCOUNT_STATUS.PAUSED || acc.status === ACCOUNT_STATUS.STOPPED || acc.status === ACCOUNT_STATUS.COMPLETED) {
        console.log(`⏭️ Skipping ${acc.accountId} (Status: ${acc.status})`);
        continue;
      }

      if (activeProcessingLocks.has(acc.accountId)) {
        console.log(`🔒 Account ${acc.accountId} is currently locked by another worker. Skipping...`);
        continue;
      }

      activeProcessingLocks.add(acc.accountId);
      liveDaemonState.currentlyRunningAccountId = acc.accountId;
      liveDaemonState.nextScheduledAccountId = null;
      liveDaemonState.nextScheduledTimeMs = null;

      await updateAccountStatus(acc.accountId, ACCOUNT_STATUS.ACTIVE).catch(() => {});

      console.log(`\n-------------------------------------------------------`);
      console.log(`▶ [Slot ${i + 1}/${shuffledAccounts.length}] Account: ${acc.accountId} at ${new Date().toISOString()}`);
      console.log(`-------------------------------------------------------`);

      const client = new SupabaseClient(acc);
      try {
        const session = await client.ensureAuthenticated();
        await updateAccountTokens(acc, session);

        const initialState = await client.getUserState().catch(() => null);
        const startXp = initialState?.total_xp ?? 0;
        const email = session.user?.email || initialState?.email || "N/A";

        const summary = await runFullDailyRoutine(client, { syncXpAmount: 500 });

        const finalState = await client.getUserState().catch(() => null);
        const endXp = finalState?.total_xp ?? (startXp + (summary.xpSync?.totalAwarded || 0));

        const packResults = [];
        if (summary.smartPackOpen && summary.smartPackOpen.opened) {
          packResults.push({
            packId: summary.smartPackOpen.targetTier || "standard",
            ok: summary.smartPackOpen.ok,
            isWin: summary.smartPackOpen.isWin || false,
            status: summary.smartPackOpen.message,
          });
        }

        const bonusAwarded = summary.dailyBonus?.awarded || 0;
        const spinAwarded = summary.dailySpin?.awarded || 0;
        const weekBonusAwarded = summary.weekBonus?.xpAwarded || 0;
        const totalNetGain = Math.max(0, endXp - startXp);
        const xpGained = summary.xpSync?.totalAwarded ?? Math.max(0, totalNetGain - bonusAwarded - spinAwarded - weekBonusAwarded);

        const accEntry = {
          accountId: acc.accountId,
          email,
          rewardCountry: finalState?.reward_country || initialState?.reward_country || "US",
          startXp,
          endXp,
          xpGained,
          streak: finalState?.current_streak ?? initialState?.current_streak ?? "N/A",
          bonusAwarded,
          spinAwarded,
          weekBonusAwarded,
          packOpens: packResults,
        };

        await updateAccountState(acc.accountId, {
          status: ACCOUNT_STATUS.COMPLETED,
          totalXp: endXp,
          streak: accEntry.streak,
          rewardCountry: accEntry.rewardCountry,
          lastRunAt: new Date().toISOString(),
          error: null,
        }).catch(() => {});

        daemonReportAccounts.push(accEntry);
        console.log(`  ✅ Routine completed & persisted to Firebase for ${acc.accountId} (XP: ${startXp} ➔ ${endXp}, Streak: ${accEntry.streak})`);
      } catch (err) {
        console.error(`  ❌ Error processing ${acc.accountId}: ${err.message}`);
        await updateAccountStatus(acc.accountId, ACCOUNT_STATUS.FAILED, err.message).catch(() => {});
        daemonReportAccounts.push({ accountId: acc.accountId, error: err.message });

        const { sendTokenExpiredAlert } = require("./lib/telegram");
        await sendTokenExpiredAlert(acc.accountId, acc.email, err.message).catch(() => {});
      } finally {
        activeProcessingLocks.delete(acc.accountId);
        liveDaemonState.currentlyRunningAccountId = null;
      }

      // If not the last account in cycle, calculate randomized sleep time until next account slot
      if (i < shuffledAccounts.length - 1) {
        const liveAccounts = loadAccounts().filter(a => a.status === ACCOUNT_STATUS.PENDING);
        const currentTotal = Math.max(1, liveAccounts.length);
        const dynamicBaseSlotMs = Math.floor(totalDayMs / currentTotal);

        const minSleepMs = Math.max(3 * 60 * 1000, Math.floor(dynamicBaseSlotMs * 0.8));
        const maxSleepMs = Math.floor(dynamicBaseSlotMs * 1.2);
        const targetSleepMs = Math.floor(Math.random() * (maxSleepMs - minSleepMs + 1)) + minSleepMs;

        const formattedDelay = formatDuration(targetSleepMs);
        const nextAccountTime = new Date(Date.now() + targetSleepMs).toISOString();

        if (shuffledAccounts[i + 1]) {
          liveDaemonState.nextScheduledAccountId = shuffledAccounts[i + 1].accountId;
          liveDaemonState.nextScheduledTimeMs = Date.now() + targetSleepMs;
        }

        const nextAccId = shuffledAccounts[i + 1]?.accountId || "Next Account";
        console.log(`\n🎯 Next account (${nextAccId}) scheduled in: ${formattedDelay} (Pending Accounts: ${currentTotal})`);
        console.log(`📅 Target execution time: ${nextAccountTime} (UTC)`);
        console.log(`-------------------------------------------------------\n`);

        await new Promise((resolve) => setTimeout(resolve, targetSleepMs));

        liveDaemonState.nextScheduledAccountId = null;
        liveDaemonState.nextScheduledTimeMs = null;
      }
    }

    console.log(`\n✨ [Cycle #${cycleCount} Step Complete] Processed batch of accounts.`);

    if (daemonReportAccounts.length > 0) {
      await sendDailyReport({ accounts: daemonReportAccounts }).catch(err => {
        console.warn("⚠️ Failed to send Telegram daily summary:", err.message);
      });
    }

    const msUntilReset = getMsUntilNextUtcReset();
    const formattedResetTime = formatDuration(msUntilReset);
    console.log(`🌙 Sleeping ${formattedResetTime} until 00:05 UTC reset...`);

    await new Promise((resolve) => {
      tokenSignalResolver = resolve;
      setTimeout(resolve, msUntilReset);
    });

    cycleCount++;
  }
}

async function showStatus(accounts) {
  console.log("\n=======================================================");
  console.log(` 📊 YapCash Multi-Account Status Overview (${accounts.length} Accounts)`);
  console.log("=======================================================\n");

  const results = await Promise.all(
    accounts.map(async (acc) => {
      const client = new SupabaseClient(acc);
      try {
        const session = await client.ensureAuthenticated();
        if (session && (session.accessToken !== acc.accessToken || session.refreshToken !== acc.refreshToken)) {
          updateAccountTokens(acc.accountId, session);
        }

        let email = session.user?.email || acc.email;
        let userObj = session.user;
        if (session.accessToken) {
          try {
            const payloadBase64 = session.accessToken.split(".")[1];
            const decoded = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf-8"));
            if (!email) email = decoded.email || decoded.user_metadata?.email || "N/A";
            if (!userObj && decoded.sub) userObj = { id: decoded.sub };
          } catch (_) {}
        }

        const userState = await client.getUserState(userObj);
        return {
          Account: acc.accountId,
          Email: email || "N/A",
          Status: acc.status || ACCOUNT_STATUS.PENDING,
          Proxy: acc.proxy ? acc.proxy.split("@")[1] || "configured" : "N/A",
          "Total XP": userState?.total_xp ?? acc.totalXp ?? "N/A",
          Streak: userState?.current_streak ?? acc.streak ?? "N/A",
          "Last Active": acc.lastRunAt || userState?.last_activity_date || "N/A",
        };
      } catch (err) {
        return {
          Account: acc.accountId,
          Email: acc.email || "N/A",
          Status: `❌ Error (${acc.status || ACCOUNT_STATUS.FAILED})`,
          Proxy: acc.proxy ? acc.proxy.split("@")[1] || "configured" : "N/A",
          "Total XP": acc.totalXp ?? "N/A",
          Streak: acc.streak ?? "N/A",
          "Last Active": acc.lastRunAt || "N/A",
        };
      }
    })
  );

  console.table(results);
}

async function runAllAccounts(accounts) {
  startTelegramPollingListener();

  await cleanupPreviousRoutineMessages().catch(err => {
    console.warn("⚠️ Failed to clean up previous Telegram routine messages:", err.message);
  });

  console.log("\n=======================================================");
  console.log(` 🚀 Executing Daily Tasks for ${accounts.length} Account(s)`);
  console.log("=======================================================\n");

  const reportAccounts = [];

  for (const acc of accounts) {
    if (activeProcessingLocks.has(acc.accountId)) {
      console.log(`🔒 Account ${acc.accountId} is already running. Skipping duplicate call...`);
      continue;
    }

    activeProcessingLocks.add(acc.accountId);
    await updateAccountStatus(acc.accountId, ACCOUNT_STATUS.ACTIVE).catch(() => {});

    console.log(`\n▶ [Account: ${acc.accountId}]`);
    const client = new SupabaseClient(acc);
    try {
      const session = await client.ensureAuthenticated();
      updateAccountTokens(acc.accountId, session);

      const initialState = await client.getUserState().catch(() => null);
      const startXp = initialState?.total_xp ?? 0;
      const email = session.user?.email || initialState?.email || "N/A";

      const summary = await runFullDailyRoutine(client, { syncXpAmount: 500 });

      const finalState = await client.getUserState().catch(() => null);
      const endXp = finalState?.total_xp ?? (startXp + (summary.xpSync?.totalAwarded || 0));

      const packResults = [];
      if (summary.smartPackOpen && summary.smartPackOpen.opened) {
        packResults.push({
          packId: summary.smartPackOpen.targetTier || "standard",
          ok: summary.smartPackOpen.ok,
          isWin: summary.smartPackOpen.isWin || false,
          status: summary.smartPackOpen.message,
        });
      }

      const bonusAwarded = summary.dailyBonus?.awarded || 0;
      const spinAwarded = summary.dailySpin?.awarded || 0;
      const weekBonusAwarded = summary.weekBonus?.xpAwarded || 0;
      const totalNetGain = Math.max(0, endXp - startXp);
      const xpGained = summary.xpSync?.totalAwarded ?? Math.max(0, totalNetGain - bonusAwarded - spinAwarded - weekBonusAwarded);

      const accEntry = {
        accountId: acc.accountId,
        email,
        rewardCountry: finalState?.reward_country || initialState?.reward_country || "US",
        startXp,
        endXp,
        xpGained,
        streak: finalState?.current_streak ?? initialState?.current_streak ?? "N/A",
        bonusAwarded,
        spinAwarded,
        weekBonusAwarded,
        packOpens: packResults,
      };

      await updateAccountState(acc.accountId, {
        status: ACCOUNT_STATUS.COMPLETED,
        totalXp: endXp,
        streak: accEntry.streak,
        rewardCountry: accEntry.rewardCountry,
        lastRunAt: new Date().toISOString(),
        error: null,
      }).catch(() => {});

      reportAccounts.push(accEntry);

      const tgRes = await sendAccountReport(accEntry).catch(err => ({ ok: false, error: err.message }));
      if (tgRes.ok) {
        console.log(`  📱 Telegram notification sent for ${acc.accountId}`);
      } else {
        console.warn(`  ⚠️ Telegram notification failed for ${acc.accountId}: ${tgRes.error || tgRes.reason || "Unknown"}`);
      }

      const jitterMs = Math.floor(Math.random() * 10000) + 5000;
      console.log(`  ⏳ Jitter pause (${(jitterMs / 1000).toFixed(1)}s) before next account...`);
      await new Promise((r) => setTimeout(r, jitterMs));

    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}`);
      await updateAccountStatus(acc.accountId, ACCOUNT_STATUS.FAILED, err.message).catch(() => {});
      const errEntry = {
        accountId: acc.accountId,
        error: err.message,
      };
      reportAccounts.push(errEntry);

      await sendAccountReport(errEntry).catch(err => {
        console.warn(`⚠️ Failed to send Telegram update for ${acc.accountId}:`, err.message);
      });
    } finally {
      activeProcessingLocks.delete(acc.accountId);
    }
  }

  console.log("\n✅ All accounts processed.");

  await sendDailyReport({ accounts: reportAccounts }).catch(err => {
    console.warn("⚠️ Failed to send Telegram daily summary:", err.message);
  });
}

async function runSingleAccount(accounts, targetId) {
  const acc = accounts.find(a => a.accountId === targetId);
  if (!acc) {
    console.error(`❌ Account '${targetId}' not found in Cloud DB`);
    process.exit(1);
  }

  if (activeProcessingLocks.has(targetId)) {
    console.warn(`⚠️ Account '${targetId}' is already active in another process.`);
    return;
  }

  activeProcessingLocks.add(targetId);
  await updateAccountStatus(targetId, ACCOUNT_STATUS.ACTIVE).catch(() => {});

  console.log(`\n🚀 Executing Daily Tasks for [Account: ${targetId}]...`);
  const client = new SupabaseClient(acc);
  try {
    const session = await client.ensureAuthenticated();
    await updateAccountTokens(acc, session);

    const summary = await runFullDailyRoutine(client, { syncXpAmount: 500 });
    const finalState = await client.getUserState().catch(() => null);
    if (finalState) {
      await updateAccountState(acc.accountId, {
        status: ACCOUNT_STATUS.COMPLETED,
        totalXp: finalState.total_xp,
        streak: finalState.current_streak,
        rewardCountry: finalState.reward_country,
        lastRunAt: new Date().toISOString(),
        error: null,
      }).catch(() => {});
    }

    console.log(`\n✅ Single account routine complete & persisted to Firebase for ${targetId}:`);
    console.log(`  └─ Daily Bonus : ${summary.dailyBonus?.message || "N/A"}`);
    console.log(`  └─ Daily Spin  : ${summary.dailySpin?.message || "N/A"}`);
    console.log(`  └─ Week Bonus  : ${summary.weekBonus?.message || "N/A"}`);
    console.log(`  └─ XP Farmed   : ${summary.xpSync?.message || "N/A"}`);
    console.log(`  └─ Smart Pack  : ${summary.smartPackOpen?.message || "N/A"}`);
  } catch (err) {
    console.error(`  ❌ Failed: ${err.message}`);
    await updateAccountStatus(targetId, ACCOUNT_STATUS.FAILED, err.message).catch(() => {});
  } finally {
    activeProcessingLocks.delete(targetId);
  }
}

async function runTaskForAccounts(accounts, targetId, taskFn, taskName) {
  const targetAccounts = targetId ? accounts.filter(a => a.accountId === targetId) : accounts;
  if (targetAccounts.length === 0) {
    console.error(`❌ Account '${targetId}' not found.`);
    process.exit(1);
  }

  console.log(`\n🚀 Executing '${taskName}' for ${targetAccounts.length} Account(s)...`);

  for (const acc of targetAccounts) {
    const client = new SupabaseClient(acc);
    try {
      const session = await client.ensureAuthenticated();
      updateAccountTokens(acc.accountId, session);
      const res = await taskFn(client);
      console.log(`  [${acc.accountId}]: ${res.message}`);
    } catch (err) {
      console.error(`  [${acc.accountId}]: ❌ Error - ${err.message}`);
    }
  }
}

function printHelp() {
  console.log(`
YapCash Multi-Account Automation CLI Runner (Cloud-Native Architecture)

Usage:
  node runner.js <command> [options]

Commands:
  daemon                    Run continuous background scheduler (auto-reschedules at 00:05 UTC)
  status                    Check authentication, XP, and streak status for all accounts
  run-all                   Execute daily bonus, spin, calendar, and XP sync for ALL accounts
  run <accountId>           Execute daily tasks for a specific account
  spin [accountId]          Trigger daily wheel spin (all or specific account)
  bonus [accountId]         Claim daily streak bonus (all or specific account)
  week-bonus [account] [day] Claim weekly calendar bonus (1-7)
  recover-cards [accountId] Check and redeem any unfulfilled gift cards won from packs
  sync [accountId] [xp]     Sync XP amount (default: 15 XP)
  open-pack [accountId] [tier] Attempt opening a pack ('standard', 'rare', 'elite')
  help                      Display this help manual
`);
}

if (require.main === module) {
  main().catch(err => {
    console.error("Fatal Error:", err);
    process.exit(1);
  });
}

module.exports = {
  getLiveDaemonState,
};

