try { require("dns").setDefaultResultOrder("ipv4first"); } catch (_) {}

const { loadAccounts, updateAccountTokens } = require("./lib/accountManager");
const SupabaseClient = require("./lib/supabaseClient");
const { runFullDailyRoutine, claimDailyBonus, claimDailySpin, claimWeekBonusCalendar, recoverUnclaimedGiftCards, syncXp, openRewardPack } = require("./lib/apiTasks");
const { sendDailyReport, sendAccountReport, cleanupPreviousRoutineMessages, startTelegramPollingListener } = require("./lib/telegram");

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "daemon";

  const accounts = loadAccounts();

  if (accounts.length === 0) {
    console.error("❌ No accounts configured. Please add account credentials to accounts.json");
    process.exit(1);
  }

  switch (command) {
    case "daemon":
      await runDaemonMode(accounts);
      break;

    case "status":
      await showStatus(accounts);
      break;

    case "run-all":
      await runAllAccounts(accounts);
      break;

    case "run":
      const targetId = args[1];
      if (!targetId) {
        console.error("❌ Usage: node runner.js run <accountId>");
        process.exit(1);
      }
      await runSingleAccount(accounts, targetId);
      break;

    case "spin":
      await runTaskForAccounts(accounts, args[1], claimDailySpin, "Daily Spin");
      break;

    case "bonus":
      await runTaskForAccounts(accounts, args[1], claimDailyBonus, "Daily Bonus");
      break;

    case "week-bonus":
      const day = args[2] ? parseInt(args[2], 10) : null;
      await runTaskForAccounts(accounts, args[1], (client) => claimWeekBonusCalendar(client, day), "Weekly Bonus Calendar");
      break;

    case "recover-cards":
      await runTaskForAccounts(accounts, args[1], (client) => recoverUnclaimedGiftCards(client), "Gift Card Recovery");
      break;

    case "sync":
      const xpAmount = parseInt(args[2] || "15", 10);
      await runTaskForAccounts(accounts, args[1], (client) => syncXp(client, xpAmount), `XP Sync (${xpAmount} XP)`);
      break;

    case "open-pack":
      const packId = args[2] || "standard";
      await runTaskForAccounts(accounts, args[1], (client) => openRewardPack(client, packId), `Open Pack (${packId})`);
      break;

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
 * Continuous 24-hour randomized staggered daemon scheduler loop.
 * Instead of running all accounts in a single burst, accounts are randomly distributed across 24 hours.
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
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
          try {
            const data = JSON.parse(body || "{}");
            const keyProvided = req.headers["x-sync-key"] || data.secretKey || data.key;

            if (keyProvided !== SYNC_SECRET) {
              res.writeHead(401, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ ok: false, error: "Unauthorized: Invalid secret key" }));
            }

            const refreshToken = data.refreshToken || data.refresh_token;
            if (!refreshToken) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ ok: false, error: "Missing refreshToken parameter" }));
            }

            // Authenticate token against Supabase
            const tempAcc = { accountId: "temp_sync", refreshToken, proxy: null };
            const client = new SupabaseClient(tempAcc);
            const session = await client.ensureAuthenticated(true).catch(err => ({ error: err.message }));

            if (!session || !session.accessToken) {
              res.writeHead(400, { "Content-Type": "application/json" });
              return res.end(JSON.stringify({ ok: false, error: `Invalid refresh token: ${session?.error || "Auth failed"}` }));
            }

            const userState = await client.getUserState().catch(() => null);
            const email = session.user?.email || userState?.email;
            const userId = session.user?.id || session.user?.sub;

            const targetId = updateAccountTokens({
              accountId: data.accountId,
              email,
              userId,
              refreshToken,
              accessToken: session.accessToken,
            });

            console.log(`⚡ [Passive Sync] Token updated live on Koyeb for ${targetId} (${email || "N/A"})`);

            const accEntry = {
              accountId: targetId,
              email: email || "N/A",
              rewardCountry: userState?.reward_country || "US",
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
              message: `Token updated live on Koyeb for ${targetId}!`,
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
    });
  } catch (err) {
    console.warn("⚠️ Could not start HTTP server:", err.message);
  }

  console.log("\n=======================================================");
  console.log(" 🤖 YapCash 24-Hour Randomized Staggered Daemon");
  console.log("=======================================================");
  console.log("Accounts are randomly spaced across 24 hours to mimic");
  console.log("100% natural human usage patterns and prevent detection.");
  console.log("Press Ctrl+C to stop daemon.");
  console.log("=======================================================\n");

  // Start background Telegram listener for 24/7 interactive pack commands & button polling
  startTelegramPollingListener();

  // Send automatic Server Boot Notification to Telegram on startup
  const { sendServerBootNotification } = require("./lib/telegram");
  await sendServerBootNotification().catch((err) => {
    console.warn("⚠️ Could not send server boot Telegram notification:", err.message);
  });

  let cycleCount = 1;

  while (true) {
    const accounts = loadAccounts(); // reload fresh accounts list
    console.log(`\n⏰ [Cycle #${cycleCount}] Distributing ${accounts.length} accounts across 24 hours...`);

    // Shuffle accounts order randomly each cycle so execution order changes daily
    const shuffledAccounts = [...accounts].sort(() => Math.random() - 0.5);

    // Calculate base interval slot per account (24 hours divided by total accounts)
    // For 14 accounts: 24h / 14 = ~102 minutes per slot
    const totalDayMs = 24 * 60 * 60 * 1000;
    const baseSlotMs = Math.floor(totalDayMs / shuffledAccounts.length);

    for (let i = 0; i < shuffledAccounts.length; i++) {
      const baseAcc = shuffledAccounts[i];
      // Re-read latest account data to ensure live updated tokens are used immediately
      const freshAccounts = loadAccounts();
      const acc = freshAccounts.find(a => a.accountId === baseAcc.accountId) || baseAcc;

      console.log(`\n-------------------------------------------------------`);
      console.log(`▶ [Slot ${i + 1}/${shuffledAccounts.length}] Account: ${acc.accountId} at ${new Date().toISOString()}`);
      console.log(`-------------------------------------------------------`);

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

        console.log(`  ✅ Routine completed for ${acc.accountId} (XP: ${startXp} ➔ ${endXp}, Streak: ${accEntry.streak})`);
      } catch (err) {
        console.error(`  ❌ Error processing ${acc.accountId}: ${err.message}`);
      }

      // If not the last account in cycle, calculate randomized sleep time until next account slot
      if (i < shuffledAccounts.length - 1) {
        // Add random jitter offset between -20 minutes and +20 minutes
        const jitterMinutes = (Math.random() * 40) - 20;
        const jitterMs = Math.floor(jitterMinutes * 60 * 1000);

        // Ensure target delay stays bounded between 30 minutes and 150 minutes
        const targetSleepMs = Math.max(30 * 60 * 1000, Math.min(150 * 60 * 1000, baseSlotMs + jitterMs));
        const formattedDelay = formatDuration(targetSleepMs);
        const nextAccountTime = new Date(Date.now() + targetSleepMs).toISOString();

        console.log(`\n🎲 Next account (${shuffledAccounts[i + 1].accountId}) scheduled in: ${formattedDelay}`);
        console.log(`📅 Target execution time: ${nextAccountTime} (UTC)`);
        console.log(`-------------------------------------------------------\n`);

        await new Promise((resolve) => setTimeout(resolve, targetSleepMs));
      }
    }

    console.log(`\n✨ [Cycle #${cycleCount} Complete] All 14 accounts processed across 24 hours.`);
    console.log(`🔄 Restarting next 24-hour cycle with new randomized order...\n`);
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
        updateAccountTokens(acc.accountId, session);

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
          "Total XP": userState?.total_xp ?? "N/A",
          Streak: userState?.current_streak ?? "N/A",
          "Last Active": userState?.last_activity_date || "N/A",
          Status: "✅ Connected",
        };
      } catch (err) {
        return {
          Account: acc.accountId,
          Email: acc.email || "N/A",
          "Total XP": "N/A",
          Streak: "N/A",
          "Last Active": "N/A",
          Status: `❌ Error (${err.message.slice(0, 30)}...)`,
        };
      }
    })
  );

  console.table(results);
}

async function runAllAccounts(accounts) {
  // Start background Telegram listener for inline button taps
  startTelegramPollingListener();

  // Clean up previous cycle's routine messages (safeguarding unconfirmed gift cards)
  await cleanupPreviousRoutineMessages().catch(err => {
    console.warn("⚠️ Failed to clean up previous Telegram routine messages:", err.message);
  });

  console.log("\n=======================================================");
  console.log(` 🚀 Executing Daily Tasks for ${accounts.length} Account(s)`);
  console.log("=======================================================\n");

  const reportAccounts = [];

  for (const acc of accounts) {
    console.log(`\n▶ [Account: ${acc.accountId}]`);
    const client = new SupabaseClient(acc);
    try {
      const session = await client.ensureAuthenticated();
      updateAccountTokens(acc.accountId, session);

      // Record baseline initial user state before farming
      const initialState = await client.getUserState().catch(() => null);
      const startXp = initialState?.total_xp ?? 0;
      const email = session.user?.email || initialState?.email || "N/A";

      const summary = await runFullDailyRoutine(client, { syncXpAmount: 500 });



      // Record final user state after farming
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

      reportAccounts.push(accEntry);

      // Dispatch instant Telegram update for this specific account
      const tgRes = await sendAccountReport(accEntry).catch(err => ({ ok: false, error: err.message }));
      if (tgRes.ok) {
        console.log(`  📱 Telegram notification sent for ${acc.accountId}`);
      } else {
        console.warn(`  ⚠️ Telegram notification failed for ${acc.accountId}: ${tgRes.error || tgRes.reason || "Unknown"}`);
      }

      // Add randomized jitter delay (5 to 15 seconds) between accounts to avoid burst rate limits
      const jitterMs = Math.floor(Math.random() * 10000) + 5000;
      console.log(`  ⏳ Jitter pause (${(jitterMs / 1000).toFixed(1)}s) before next account...`);
      await new Promise((r) => setTimeout(r, jitterMs));

    } catch (err) {
      console.error(`  ❌ Failed: ${err.message}`);
      const errEntry = {
        accountId: acc.accountId,
        error: err.message,
      };
      reportAccounts.push(errEntry);

      await sendAccountReport(errEntry).catch(err => {
        console.warn(`⚠️ Failed to send Telegram update for ${acc.accountId}:`, err.message);
      });
    }
  }

  console.log("\n✅ All accounts processed.");

  // Dispatch short 3-line Telegram cycle summary
  await sendDailyReport({ accounts: reportAccounts }).catch(err => {
    console.warn("⚠️ Failed to send Telegram daily summary:", err.message);
  });
}

async function runSingleAccount(accounts, targetId) {
  const acc = accounts.find(a => a.accountId === targetId);
  if (!acc) {
    console.error(`❌ Account '${targetId}' not found in accounts.json`);
    process.exit(1);
  }

  console.log(`\n🚀 Executing Daily Tasks for [Account: ${targetId}]...`);
  const client = new SupabaseClient(acc);
  try {
    const session = await client.ensureAuthenticated();
    updateAccountTokens(acc.accountId, session);

    const summary = await runFullDailyRoutine(client, { syncXpAmount: 500 });


  } catch (err) {
    console.error(`  ❌ Failed: ${err.message}`);
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
YapCash Multi-Account Automation CLI Runner (Approach 2 - Pure API)

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

main().catch(err => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
