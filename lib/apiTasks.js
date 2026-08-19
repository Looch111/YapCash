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
async function syncXpUntilCap(client, targetDailyXp = 500, batchAmount = 500) {
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
 * Claims the weekly calendar bonus.
 */
async function claimWeekBonusCalendar(client, targetDay = null) {
  try {
    let dayToClaim = targetDay;

    if (!dayToClaim) {
      const claims = await client.getWeekBonusClaims().catch(() => []);
      const claimedDays = new Set((claims || []).map((c) => c.day));
      for (let day = 1; day <= 7; day++) {
        if (!claimedDays.has(day)) {
          dayToClaim = day;
          break;
        }
      }
    }

    if (!dayToClaim) {
      return { ok: true, message: "All weekly bonus calendar days already claimed for active season." };
    }

    const res = await client.claimWeekBonus(dayToClaim);
    const xpAwarded = res?.xp_awarded ?? 0;
    const rewardType = res?.reward_type || "xp";

    return {
      ok: true,
      day: dayToClaim,
      xpAwarded,
      rewardType,
      message: `Weekly bonus Day ${dayToClaim} claimed: +${xpAwarded} XP (${rewardType.toUpperCase()})`,
    };
  } catch (err) {
    if (err.message.includes("already_claimed")) {
      return { ok: false, reason: "already_claimed", message: `Weekly bonus Day ${targetDay || "calendar"} already claimed.` };
    }
    return { ok: false, error: err.message, message: `Weekly bonus claim failed: ${err.message}` };
  }
}

/**
 * Checks for unfulfilled gift cards won from pack openings and auto-triggers redemption.
 */
async function recoverUnclaimedGiftCards(client, defaultBrand = "amazon") {
  const { fetchWithRetry } = require("./http");
  const { recordWin } = require("./notifier");

  try {
    const unfulfilled = await client.getUnclaimedGiftCards();
    if (!unfulfilled || unfulfilled.length === 0) {
      return { ok: true, recoveredCount: 0, message: "No unfulfilled gift cards found." };
    }

    const session = await client.ensureAuthenticated();
    const userEmail = session?.user?.email || "N/A";
    let recoveredCount = 0;
    const results = [];

    for (const card of unfulfilled) {
      const denomination = card.denomination || 5;
      const brand = defaultBrand;

      try {
        const res = await fetchWithRetry("https://yapcash.ai/api/redeem-pack", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${client.accessToken}`,
          },
          body: JSON.stringify({ brand, denomination, timezoneOffsetMinutes: new Date().getTimezoneOffset() }),
          proxy: client.proxy,
        }, 2, 1000);

        const data = await res.json().catch(() => ({}));

        if (res.ok) {
          recoveredCount++;
          recordWin({
            accountId: client.accountId,
            email: userEmail,
            packTier: "recovered_pack",
            brand,
            denom: denomination,
            code: data.orderId || "FULFILLED",
          });
          results.push({ id: card.id, ok: true, brand, denomination, orderId: data.orderId });
        } else {
          results.push({ id: card.id, ok: false, reason: data.error || `HTTP ${res.status}` });
        }
      } catch (err) {
        results.push({ id: card.id, ok: false, error: err.message });
      }
    }

    return {
      ok: true,
      recoveredCount,
      results,
      message: `Recovered ${recoveredCount}/${unfulfilled.length} pending gift card(s).`,
    };
  } catch (err) {
    return { ok: false, error: err.message, message: `Gift card recovery failed: ${err.message}` };
  }
}

/**
 * Attempts to open reward packs (Standard, Rare, Elite) via yapcash.ai API.
 * Features: Preflight region & pool checks, auto token refresh on 401, structured outcome return, and audit logging to pack_history.json.
 */
async function openRewardPack(client, packId = "standard") {
  const { fetchWithRetry } = require("./http");
  const { recordWin, recordPackHistory } = require("./notifier");

  try {
    let session = await client.ensureAuthenticated();

    // 1. Preflight Region Check
    const region = await client.getRewardRegion().catch(() => ({ ok: false }));
    if (region.ok && region.confirmed === false) {
      return { ok: false, packId, reason: "reward_country_required", message: "Reward country required for account" };
    }
    if (region.ok && region.canOpenPacks === false) {
      return { ok: false, packId, reason: "rewards_unavailable_in_region", message: `Rewards unavailable in country (${region.country || "N/A"})` };
    }

    // 2. Preflight Pool Check
    const pool = await client.getRewardPool().catch(() => ({ ok: false }));
    if (pool.ok) {
      if (pool.hasPendingGiftCard) {
        return { ok: false, packId, reason: "unresolved_gift_card", message: "Account has unresolved pending gift card" };
      }
      if (pool.cooldownUntil && Date.parse(pool.cooldownUntil) > Date.now()) {
        return { ok: false, packId, reason: "winner_cooldown", message: `Winner cooldown active until ${pool.cooldownUntil}` };
      }
      if (pool.isOpen === false) {
        return { ok: false, packId, reason: "reward_pool_depleted", message: "Reward pool is currently depleted or closed" };
      }
    }

    let res = await fetchWithRetry("https://yapcash.ai/api/open-pack", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${client.accessToken}`,
      },
      body: JSON.stringify({ packId }),
      proxy: client.proxy,
    }, 2, 1000);

    // If 401 Unauthorized, refresh authentication and retry once
    if (res.status === 401) {
      session = await client.ensureAuthenticated(true);
      res = await fetchWithRetry("https://yapcash.ai/api/open-pack", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${client.accessToken}`,
        },
        body: JSON.stringify({ packId }),
        proxy: client.proxy,
      }, 2, 1000);
    }

    const result = await res.json().catch(() => ({}));
    const userState = await client.getUserState().catch(() => ({}));
    const userEmail = session?.user?.email || userState?.email || "N/A";

    if (res.ok && result.ok !== false) {
      const rewardInfo = result.reward || result.prize || result.data || result;
      let winMsg = `Pack opened! (${packId})`;
      let isGiftCardWin = false;
      let giftCardData = null;
      let xpBonus = 0;

      if (rewardInfo?.type === "gift_card" || rewardInfo?.brand || rewardInfo?.claimUrl || rewardInfo?.code) {
        isGiftCardWin = true;
        const brand = rewardInfo.brand || rewardInfo.name || "amazon";
        const denomination = rewardInfo.denomination || rewardInfo.denom || 5;
        const code = rewardInfo.code || rewardInfo.claimUrl || rewardInfo.voucher || JSON.stringify(rewardInfo);

        giftCardData = { brand, denomination, code };
        winMsg = `GIFT CARD WON! Brand: ${brand.toUpperCase()} $${denomination} (Code: ${code})`;

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
        recordWin({
          accountId: client.accountId,
          email: userEmail,
          packTier: packId,
          brand,
          denom: denomination,
          code,
        });
      } else {
        xpBonus = rewardInfo?.xp || rewardInfo?.amount || rewardInfo?.xpAwarded || rewardInfo?.value || result?.xp || result?.amount || 0;
        if (xpBonus > 0) {
          winMsg = `Pack opened! (+${xpBonus.toLocaleString()} XP awarded)`;
        } else {
          winMsg = `Pack opened successfully! (${packId.toUpperCase()})`;
        }
      }

      recordPackHistory({
        accountId: client.accountId,
        email: userEmail,
        packTier: packId,
        status: isGiftCardWin ? "gift_card_win" : "xp_bonus",
        xpAwarded: xpBonus,
        giftCard: giftCardData,
        message: winMsg,
      });

      return {
        ok: true,
        packId,
        isWin: isGiftCardWin,
        giftCard: giftCardData,
        xpAwarded: xpBonus,
        result,
        message: winMsg,
      };
    }

    const reason = result.reason || result.error || result.message || `HTTP ${res.status}`;
    const failMsg = `Pack open (${packId}): ${reason}`;

    recordPackHistory({
      accountId: client.accountId,
      email: userEmail,
      packTier: packId,
      status: "failed",
      error: reason,
      message: failMsg,
    });

    return { ok: false, packId, reason, message: failMsg };
  } catch (err) {
    const errorMsg = `Pack open (${packId}) skipped: ${err.message}`;
    recordPackHistory({
      accountId: client.accountId,
      email: "N/A",
      packTier: packId,
      status: "failed",
      error: err.message,
      message: errorMsg,
    });

    return { ok: false, packId, error: err.message, message: errorMsg };
  }
}

const PACK_COSTS = {
  standard: 500,
  rare: 1000,
  elite: 2000,
};

const PACK_LIMIT_ROWS = [
  { minStreak: 0, limits: { standard: 4, rare: 1, elite: 1 } },
  { minStreak: 1, limits: { standard: 4, rare: 1, elite: 1 } },
  { minStreak: 2, limits: { standard: 5, rare: 2, elite: 1 } },
  { minStreak: 3, limits: { standard: 6, rare: 3, elite: 1 } },
  { minStreak: 4, limits: { standard: 7, rare: 4, elite: 2 } },
  { minStreak: 5, limits: { standard: 8, rare: 5, elite: 3 } },
  { minStreak: 6, limits: { standard: 9, rare: 6, elite: 4 } },
  { minStreak: 7, limits: { standard: 10, rare: 6, elite: 4 } },
];

function getWeeklyPackLimits(streak = 0) {
  let best = PACK_LIMIT_ROWS[0].limits;
  for (const row of PACK_LIMIT_ROWS) {
    if (streak >= row.minStreak) best = row.limits;
  }
  return best;
}

/**
 * Smart Pack Decision Engine: Checks account balance, streak, and preflight rules to automatically open the highest tier eligible pack.
 */
async function autoOpenBestPacks(client) {
  try {
    const userState = await client.getUserState().catch(() => null);
    if (!userState) {
      return { ok: false, message: "Smart pack decision engine skipped: user profile state unavailable" };
    }

    const currentXp = userState.total_xp || 0;
    const currentStreak = userState.current_streak || 0;
    const preferredBrand = client.account?.preferredBrand || "amazon";

    // Determine highest eligible pack tier
    let targetTier = null;
    if (currentXp >= PACK_COSTS.elite && currentStreak >= 4) {
      targetTier = "elite";
    } else if (currentXp >= PACK_COSTS.rare && currentStreak >= 2) {
      targetTier = "rare";
    } else if (currentXp >= PACK_COSTS.standard) {
      targetTier = "standard";
    }

    if (!targetTier) {
      return {
        ok: true,
        opened: false,
        message: `No pack opened: Balance is ${currentXp.toLocaleString()} XP (Streak: ${currentStreak} days). Standard requires 500 XP, Rare 1,000 XP (Streak 2+), Elite 2,000 XP (Streak 4+).`,
      };
    }

    const openResult = await openRewardPack(client, targetTier);
    return {
      ok: openResult.ok,
      opened: true,
      targetTier,
      preferredBrand,
      ...openResult,
    };
  } catch (err) {
    return { ok: false, error: err.message, message: `Auto pack decision engine failed: ${err.message}` };
  }
}

/**
 * Master Smart Waterfall Engine (Multi-Pack Auto-Drain):
 * Continuously drains eligible packs (Elite -> Rare -> Standard) based on live XP balance,
 * streak qualifications, and weekly quotas.
 * Stops immediately if a Gift Card is won (to respect server 24-hr winner cooldown),
 * if XP drops below 500, or if weekly quota limits are hit.
 */
async function drainAccountPacks(client, maxOpensPerRun = 10) {
  const opens = [];
  let totalXpSpent = 0;
  let hitGiftCard = false;
  const disabledTiers = new Set();

  for (let i = 0; i < maxOpensPerRun; i++) {
    const userState = await client.getUserState().catch(() => null);
    if (!userState) break;

    const currentXp = userState.total_xp || 0;
    const currentStreak = userState.current_streak || 0;

    let targetTier = null;
    if (!disabledTiers.has("elite") && currentXp >= PACK_COSTS.elite && currentStreak >= 4) {
      targetTier = "elite";
    } else if (!disabledTiers.has("rare") && currentXp >= PACK_COSTS.rare && currentStreak >= 2) {
      targetTier = "rare";
    } else if (!disabledTiers.has("standard") && currentXp >= PACK_COSTS.standard) {
      targetTier = "standard";
    }

    if (!targetTier) break;

    const result = await openRewardPack(client, targetTier);
    opens.push({ tier: targetTier, ...result });

    if (result.ok) {
      totalXpSpent += PACK_COSTS[targetTier];
      if (result.isWin && result.giftCard) {
        hitGiftCard = true;
        break;
      }
    } else {
      const raw = `${result.reason || ""} ${result.message || ""} ${result.error || ""}`.toLowerCase();
      if (raw.includes("limit")) {
        disabledTiers.add(targetTier);
      } else if (raw.includes("cooldown") || raw.includes("insufficient") || raw.includes("depleted") || raw.includes("country") || raw.includes("unresolved")) {
        break;
      }
    }

    if (i < maxOpensPerRun - 1) {
      await humanDelay(2, 4);
    }
  }

  const successfulOpens = opens.filter((o) => o.ok);

  const summaryMsg = hitGiftCard
    ? `🏆 GIFT CARD WON! Drained ${successfulOpens.length} pack(s), spent ${totalXpSpent.toLocaleString()} XP.`
    : successfulOpens.length > 0
      ? `Drained ${successfulOpens.length} pack(s), spent ${totalXpSpent.toLocaleString()} XP.`
      : `No eligible packs opened.`;

  return {
    ok: true,
    totalOpens: successfulOpens.length,
    totalXpSpent,
    hitGiftCard,
    opens,
    message: summaryMsg,
  };
}

async function humanDelay() {
  return;
}

/**
 * Runs the complete daily 7-step routine for an account:
 * 1. Streak Reconciliation
 * 2. Daily Bonus
 * 3. Daily Spin
 * 4. Weekly Calendar Bonus
 * 5. Telemetry Session Flush
 * 6. Recover Unclaimed Gift Cards (using preferredBrand)
 * 7. Farm XP until 500 XP daily cap reached
 * 8. Smart Pack Decision Engine (Auto-open highest eligible pack tier)
 */
async function runFullDailyRoutine(client, options = {}) {
  const preferredBrand = client.account?.preferredBrand || "amazon";
  const summary = {
    streakHeal: null,
    dailyBonus: null,
    dailySpin: null,
    weekBonus: null,
    telemetryFlush: null,
    recoveredCards: null,
    xpSync: null,
    smartPackOpen: null,
  };

  // 1. Reconcile / Heal Streak authoritatively on server
  summary.streakHeal = await client.updateStreak().catch(() => null);
  if (summary.streakHeal?.currentStreak != null) {
    console.log(`  └─ Streak: Reconciled (${summary.streakHeal.currentStreak} days)`);
  }
  await humanDelay(5, 20);

  // 2. Claim Daily Bonus
  summary.dailyBonus = await claimDailyBonus(client);
  if (summary.dailyBonus) {
    console.log(`  └─ Bonus:  ${summary.dailyBonus.message}`);
  }
  await humanDelay(5, 20);

  // 3. Claim Daily Spin
  summary.dailySpin = await claimDailySpin(client);
  if (summary.dailySpin) {
    console.log(`  └─ Spin:   ${summary.dailySpin.message}`);
  }
  await humanDelay(5, 20);

  // 4. Claim Weekly Bonus Calendar
  summary.weekBonus = await claimWeekBonusCalendar(client);
  if (summary.weekBonus) {
    console.log(`  └─ Calendar: ${summary.weekBonus.message}`);
  }
  await humanDelay(5, 20);

  // 5. Transmit Active Chat Telemetry Flush
  summary.telemetryFlush = await client.flushSession(2, 50, 180).catch((err) => ({ ok: false, error: err.message }));
  if (summary.telemetryFlush) {
    console.log(`  └─ Telemetry: ${summary.telemetryFlush.ok ? "Flushed active chat session" : summary.telemetryFlush.error}`);
  }
  await humanDelay(5, 20);

  // 6. Recover Unclaimed Gift Cards using preferredBrand
  summary.recoveredCards = await recoverUnclaimedGiftCards(client, preferredBrand);
  if (summary.recoveredCards && summary.recoveredCards.recoveredCount > 0) {
    console.log(`  └─ Recovered: ${summary.recoveredCards.message}`);
  }
  await humanDelay(5, 20);

  // 7. Farm XP until 500 XP daily cap is reached
  const xpTarget = options.syncXpAmount || 500;
  summary.xpSync = await syncXpUntilCap(client, xpTarget);
  if (summary.xpSync) {
    console.log(`  └─ Sync:   ${summary.xpSync.message}`);
  }
  await humanDelay(5, 20);

  // 8. Smart Pack Decision Engine (Default: disabled to save XP for Telegram /openpack)
  if (options.autoOpenPacks) {
    summary.smartPackOpen = await autoOpenBestPacks(client);
    if (summary.smartPackOpen) {
      console.log(`  └─ Smart Pack: ${summary.smartPackOpen.message}`);
    }
  } else {
    summary.smartPackOpen = { opened: false, message: "Auto-open disabled (Saving XP for /openpack)" };
    console.log(`  └─ Smart Pack: Auto-open disabled (Saving XP for Telegram /openpack)`);
  }

  return summary;
}

module.exports = {
  PACK_COSTS,
  PACK_LIMIT_ROWS,
  getWeeklyPackLimits,
  autoOpenBestPacks,
  drainAccountPacks,
  claimDailyBonus,
  claimDailySpin,
  claimWeekBonusCalendar,
  recoverUnclaimedGiftCards,
  syncXp,
  syncXpUntilCap,
  openRewardPack,
  runFullDailyRoutine,
};
