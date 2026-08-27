const { SupabaseClient } = require("../lib/supabaseClient");
const { updateAccountTokens } = require("../lib/accountManager");
const { fetchAccountsFromFirestore } = require("../lib/firebaseClient");

const refreshToken = process.argv[2];

if (!refreshToken) {
  console.log("Usage: node scripts/add_account.js <refreshToken>");
  process.exit(1);
}

(async () => {
  console.log("⚡ Authenticating refresh token with Supabase...");
  const tempAcc = { accountId: "temp_sync", refreshToken, proxy: null };
  const client = new SupabaseClient(tempAcc);
  const session = await client.ensureAuthenticated(true).catch(err => ({ error: err.message }));

  if (!session || !session.accessToken) {
    console.error("❌ Invalid Refresh Token:", session?.error || "Auth failed");
    process.exit(1);
  }

  const userState = await client.getUserState().catch(() => null);
  const email = session.user?.email || userState?.email;
  const userId = session.user?.id || session.user?.sub;

  console.log(`✅ Authenticated user: ${email} (ID: ${userId})`);

  const accountId = updateAccountTokens({
    email,
    userId,
    refreshToken,
    accessToken: session.accessToken,
    rewardCountry: userState?.reward_country || "US",
  });

  console.log(`✨ Successfully saved ${accountId} (${email}) to Firebase Firestore Cloud DB!`);

  // Wait 1s and print live Firestore accounts
  await new Promise(r => setTimeout(r, 1500));
  const accounts = await fetchAccountsFromFirestore();
  console.log(`\n🔥 Current Firestore Accounts Count: ${accounts.length}`);
  accounts.forEach(a => console.log(`  - [${a.accountId}] ${a.email} | Country: ${a.rewardCountry || "US"} | Proxy: ${a.proxy}`));
})();
