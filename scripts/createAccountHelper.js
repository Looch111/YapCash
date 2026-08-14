const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { loadAccounts, saveAccounts } = require("../lib/accountManager");

/**
 * Helper function to parse proxy URL into Playwright proxy format:
 * "http://user:pass@ip:port" -> { server: "http://ip:port", username, password }
 */
function parseProxy(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const url = new URL(proxyUrl);
    const server = `${url.protocol}//${url.hostname}:${url.port}`;
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    return { server, username, password };
  } catch (_) {
    return { server: proxyUrl };
  }
}

async function createAccountHelper(options = {}) {
  const accountId = options.accountId || `account_${Date.now().toString().slice(-4)}`;
  const proxyUrl = options.proxy;
  const refCode = options.refCode || options.ref;

  console.log("\n=======================================================");
  console.log(" 🚀 YapCash Automated Account Creator & Token Extractor");
  console.log("=======================================================");
  console.log(`👤 Target Account ID: ${accountId}`);
  console.log(`🌐 Dedicated Proxy:  ${proxyUrl || "Direct (No Proxy)"}`);
  console.log(`🎁 Referral Code:    ${refCode || "None"}`);
  console.log("=======================================================\n");

  const playwrightProxy = parseProxy(proxyUrl);
  const launchOptions = {
    headless: false, // Show browser for Google OAuth sign-in
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  };
  if (playwrightProxy) {
    launchOptions.proxy = playwrightProxy;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

  // Construct target URL with referral code
  let targetUrl = "https://yapcash.ai";
  if (refCode) {
    targetUrl += `?ref=${encodeURIComponent(refCode)}`;
  }

  console.log(`🌐 Navigating to YapCash onboarding: ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: "networkidle" }).catch(() => {});

  console.log("\n-------------------------------------------------------");
  console.log("👉 ACTION REQUIRED IN BROWSER:");
  console.log("   1. Click 'Sign in with Google' on the YapCash page.");
  console.log("   2. Complete Google Sign-In with your target Gmail.");
  console.log("   3. The script will automatically capture your Refresh Token!");
  console.log("-------------------------------------------------------\n");

  let extractedTokens = null;

  // Polling loop to detect Supabase Auth token in localStorage or cookies
  const startTime = Date.now();
  const maxWaitMs = 5 * 60 * 1000; // 5 minutes timeout

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const storageState = await page.evaluate(() => {
        const items = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          items[key] = localStorage.getItem(key);
        }
        return items;
      });

      // Find Supabase auth key (usually starts with sb- or contains auth-token)
      for (const [key, value] of Object.entries(storageState)) {
        if (key.includes("auth-token") || key.includes("sb-") || key.includes("supabase")) {
          try {
            const parsed = JSON.parse(value);
            if (parsed.refresh_token && parsed.access_token) {
              extractedTokens = {
                refreshToken: parsed.refresh_token,
                accessToken: parsed.access_token,
                user: parsed.user,
              };
              break;
            }
          } catch (_) {}
        }
      }

      if (extractedTokens) break;
    } catch (_) {}

    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!extractedTokens) {
    console.error("❌ Timeout: Refresh token was not captured within 5 minutes.");
    await browser.close();
    process.exit(1);
  }

  const userEmail = extractedTokens.user?.email || "N/A";
  console.log("🎉 SUCCESS! Supabase Refresh Token Intercepted!");
  console.log(`   📧 Account Email: ${userEmail}`);
  console.log(`   🔑 Refresh Token: ${extractedTokens.refreshToken.slice(0, 15)}...`);

  // Load existing accounts and append/update
  const accountsPath = path.resolve(__dirname, "../accounts.json");
  let accounts = [];
  try {
    accounts = loadAccounts();
  } catch (_) {}

  const existingIndex = accounts.findIndex((a) => a.accountId === accountId);
  const newAccountObj = {
    accountId,
    refreshToken: extractedTokens.refreshToken,
    proxy: proxyUrl || "",
    preferredBrand: "apple",
    accessToken: extractedTokens.accessToken,
  };

  if (existingIndex >= 0) {
    accounts[existingIndex] = { ...accounts[existingIndex], ...newAccountObj };
    console.log(`📝 Updated existing entry for '${accountId}' in accounts.json`);
  } else {
    accounts.push(newAccountObj);
    console.log(`➕ Appended new account entry '${accountId}' to accounts.json`);
  }

  saveAccounts(accounts);
  console.log("\n✅ Account successfully added and verified in accounts.json!");

  await browser.close();
  return newAccountObj;
}

// CLI Execution Handler
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--account" || args[i] === "-a") options.accountId = args[++i];
    else if (args[i] === "--proxy" || args[i] === "-p") options.proxy = args[++i];
    else if (args[i] === "--ref" || args[i] === "-r") options.refCode = args[++i];
    else if (!options.accountId) options.accountId = args[i];
    else if (!options.proxy) options.proxy = args[i];
    else if (!options.refCode) options.refCode = args[i];
  }

  createAccountHelper(options).catch((err) => {
    console.error("Fatal Account Creation Error:", err.message);
    process.exit(1);
  });
}

module.exports = { createAccountHelper };
