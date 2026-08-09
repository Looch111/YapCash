const { flushSession, createClientEvent, pickVariableXp } = require("./telemetry");
const { recordWin } = require("./notifier");

/**
 * Claims the daily streak bonus.
 */
async function claimDailyBonus(client) {
  await flushSession(client, { activeSeconds: 180, messages: 2, chatXp: 30 });
  try {
    const res = await client.rpc("record_daily_bonus", {});
    return {
      ok: true,
      awarded: res?.awarded || 0,
      totalXp: res?.total_xp || null,
      currentStreak: res?.current_streak || null,
      message: `Daily bonus claimed: +${res?.awarded || 0} XP (Streak: ${res?.current_streak || "N/A"})`,
    };
  } catch (err) {
    if (err.message.includes("bonus_already_claimed") || err.message.includes("already_claimed")) {
      return { ok: false, reason: "already_claimed", message: "Daily bonus already claimed today." };
    }
    return { ok: false, error: err.message, message: `Daily bonus failed: ${err.message}` };
  }
}

/**
 * Claims the daily wheel spin.
 */
async function claimDailySpin(client) {
  try {
    const res = await client.rpc("record_spin", {});
    return {
      ok: true,
      awarded: res?.awarded || 0,
      label: res?.label || "Prize",
      totalXp: res?.total_xp || null,
      currentStreak: res?.current_streak || null,
      message: `Daily spin result: +${res?.awarded || 0} XP (${res?.label || "Prize"})`,
    };
  } catch (err) {
    if (err.message.includes("spin_already_used_today") || err.message.includes("already_used")) {
      return { ok: false, reason: "already_used", message: "Daily spin already used today." };
    }
    return { ok: false, error: err.message, message: `Daily spin failed: ${err.message}` };
  }
}

/**
 * Syncs a single batch of pending XP.
 */
async function syncXp(client, amount, provider = "chatgpt") {
  const crypto = require("crypto");
  try {
    const userState = await client.getUserState();
    const userId = userState?.id;
    if (!userId) return { ok: false, message: "XP sync skipped: user ID unavailable" };

    const xpAmount = amount || pickVariableXp();

    // Flush session active time & message telemetry first
    await flushSession(client, { activeSeconds: 60, messages: 1, chatXp: xpAmount });

    const res = await client.rpc("sync_pending_xp", {
      p_user_id: userId,
      p_amount: xpAmount,
      p_nonce: crypto.randomUUID(),
      p_provider: provider,
      p_messages: 1,
    });

    if (res && res.ok === false && res.error) {
      if (res.error.includes("rate_limited")) {
        return {
          ok: false,
          reason: "rate_limited",
          result: res,
          message: "Server 90s rate limit active — XP sync queued",
        };
      }
      return { ok: false, reason: res.error, result: res, message: `XP sync server notice: ${res.error}` };
    }

    return {
      ok: true,
      result: res,
      message: `XP sync complete (+${res?.awarded ?? amount} XP)`,
    };
  } catch (err) {
    if (err.message.includes("rate_limited")) {
      return { ok: false, reason: "rate_limited", message: "Server 90s rate limit active" };
    }
    return { ok: false, error: err.message, message: `XP sync failed: ${err.message}` };
  }
}

/**
 * Automatically farms XP in batches until hitting the Server Daily Cap.
 * Rotates AI providers (chatgpt, claude, perplexity, gemini) and respects the 90s server cooldown.
 */
async function syncXpUntilCap(client, targetDailyXp = 500, batchAmount = 25) {
  let totalAwarded = 0;
  let batchCount = 0;
  const maxBatches = Math.ceil(targetDailyXp / batchAmount);
  const providers = ["chatgpt", "claude", "perplexity", "gemini"];

  for (let i = 0; i < maxBatches; i++) {
    const provider = providers[i % providers.length];
    const res = await syncXp(client, batchAmount, provider);

    if (!res.ok) {
      if (res.reason === "rate_limited") {
        // Wait 92s for server rate limit to elapse and continue
        await new Promise((r) => setTimeout(r, 92000));
        continue;
      }
      if (batchCount === 0) return res;
      break;
    }

    const awarded = res.result?.awarded ?? 0;
    if (awarded === 0) {
      // Server daily cap reached for today!
      break;
    }

    totalAwarded += awarded;
    batchCount++;

    // If more batches needed, wait 92s for server cooldown between batches
    if (i < maxBatches - 1) {
      await new Promise((r) => setTimeout(r, 92000));
    }
  }

  return {
    ok: true,
    totalAwarded,
    batchCount,
    message: totalAwarded > 0
      ? `Farmed +${totalAwarded} XP across ${batchCount} batch(es) (Daily Cap Reached 🎯)`
      : `Daily XP Cap maxed out for today (+0 XP)`,
  };
}

/**
 * Attempts to open reward packs (Standard, Rare, Elite) via yapcash.ai API.
 */
async function openRewardPack(client, packId = "standard") {
  const { fetchWithRetry } = require("./http");
  try {
    await client.ensureAuthenticated();
    const res = await fetchWithRetry("https://yapcash.ai/api/open-pack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${client.accessToken}`,
      },
      body: JSON.stringify({ packId }),
      proxy: client.proxy,
    }, 2, 1000);

    const result = await res.json().catch(() => ({}));
    if (res.ok && result.ok !== false) {
      const rewardInfo = result.reward || result.prize || result.data || result;
      let winMsg = `Pack opened! (${packId})`;
      if (rewardInfo?.type === "gift_card" || rewardInfo?.brand || rewardInfo?.claimUrl || rewardInfo?.code) {
        const brand = rewardInfo.brand || rewardInfo.name || "amazon";
        const denomination = rewardInfo.denomination || rewardInfo.denom || 5;
        const code = rewardInfo.code || rewardInfo.claimUrl || rewardInfo.voucher || JSON.stringify(rewardInfo);

        // Auto-trigger Tremendous email fulfillment
        try {
          await fetchWithRetry("https://yapcash.ai/api/redeem-pack", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${client.accessToken}`,
            },
            body: JSON.stringify({ brand, denomination, timezoneOffsetMinutes: new Date().getTimezoneOffset() }),
            proxy: client.proxy,
          }, 2, 1000);
        } catch (_) {}

        // Record win to wins.json
        const userState = await client.getUserState().catch(() => ({}));
        recordWin({
          accountId: client.accountId,
          email: userState?.email || "N/A",
          packTier: packId,
          brand,
          denomination,
          codeOrUrl: code,
        });

        winMsg = `🎉 GIFT CARD WON & LOGGED TO wins.json! (${packId.toUpperCase()}) -> Brand: ${brand} ($${denomination}) | Code/URL: ${code}`;
      } else if (rewardInfo?.xp || rewardInfo?.amount) {
        winMsg = `Pack opened (${packId}): +${rewardInfo.xp || rewardInfo.amount} XP Bonus!`;
      }

      return {
        ok: true,
        result,
        message: winMsg,
      };
    }

    const reason = result.reason || result.error || result.message || `HTTP ${res.status}`;
    return { ok: false, reason, message: `Pack open (${packId}): ${reason}` };
  } catch (err) {
    return { ok: false, error: err.message, message: `Pack open (${packId}) skipped: ${err.message}` };
  }
}

/**
 * Runs the complete daily maxing routine for an account:
 * 1. Daily Bonus
 * 2. Daily Spin
 * 3. Farm XP until 500 XP daily cap reached
 * 4. Attempt opening eligible reward packs (standard, rare, elite)
 */
async function runFullDailyRoutine(client, options = {}) {
  const summary = {
    dailyBonus: null,
    dailySpin: null,
    xpSync: null,
    packOpens: [],
  };

  // 1. Claim Daily Bonus
  summary.dailyBonus = await claimDailyBonus(client);

  // 2. Claim Daily Spin
  summary.dailySpin = await claimDailySpin(client);

  // 3. Farm XP until 500 XP daily cap is reached (or custom amount if passed)
  const xpTarget = options.syncXpAmount || 500;
  summary.xpSync = await syncXpUntilCap(client, xpTarget);

  // 4. Try opening eligible packs (standard, rare, elite)
  const packTypes = options.openPackId ? [options.openPackId] : ["standard", "rare", "elite"];
  for (const packId of packTypes) {
    const packRes = await openRewardPack(client, packId);
    summary.packOpens.push(packRes);
  }

  return summary;
}

module.exports = {
  claimDailyBonus,
  claimDailySpin,
  syncXp,
  syncXpUntilCap,
  openRewardPack,
  runFullDailyRoutine,
};
