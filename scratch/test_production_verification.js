const { fetchAccountsFromFirestore, getFirestoreStatus, firestoreAccountsCache } = require("../lib/firebaseClient");
const { loadAccounts, updateAccountTokens, ACCOUNT_STATUS } = require("../lib/accountManager");

(async () => {
  console.log("=================================================");
  console.log(" 🧪 YapCash Production System Verification Suite ");
  console.log("=================================================");

  // Test 1: Check Firestore status
  const status = getFirestoreStatus();
  console.log(`\n1. Firestore Client Status:`);
  console.log(`   Connected   : ${status.connected}`);
  console.log(`   Client Mode : ${status.mode}`);
  console.log(`   Cached Count: ${status.cachedCount}`);
  console.log(`   Project ID  : ${status.projectId}`);

  // Test 2: Perform Cloud DB Hydration
  console.log(`\n2. Performing Cloud DB Hydration...`);
  const accounts = await fetchAccountsFromFirestore().catch(err => {
    console.error("   ❌ Fetch failed:", err.message);
    return [];
  });

  console.log(`   ✅ Loaded ${accounts.length} account(s) from Firebase Cloud DB.`);
  accounts.forEach(a => {
    console.log(`      └─ [${a.accountId}] ${a.email || "N/A"} | Country: ${a.rewardCountry || "US"} | Status: ${a.status || "PENDING"}`);
  });

  // Test 3: Test Hydration Guard & Token Sync matching
  if (accounts.length > 0) {
    const sampleAccount = accounts[0];
    console.log(`\n3. Testing Token Sync & Matching for existing account: ${sampleAccount.accountId} (${sampleAccount.email})...`);

    const resultId = await updateAccountTokens({
      email: sampleAccount.email,
      userId: sampleAccount.userId,
      refreshToken: sampleAccount.refreshToken,
      accessToken: sampleAccount.accessToken,
    });

    console.log(`   Result Account ID: ${resultId}`);
    if (resultId === sampleAccount.accountId) {
      console.log(`   ✅ PASS: Matched existing account '${sampleAccount.accountId}' without creating a ghost account!`);
    } else {
      console.error(`   ❌ FAIL: Created new ID '${resultId}' instead of matching existing '${sampleAccount.accountId}'!`);
    }
  }

  // Test 4: Hydration Guard on empty unverified state
  console.log(`\n4. Testing Hydration Guard with invalid payload...`);
  const invalidRes = await updateAccountTokens({});
  if (invalidRes === null) {
    console.log(`   ✅ PASS: Successfully rejected empty token update payload.`);
  } else {
    console.error(`   ❌ FAIL: Created account for invalid payload: ${invalidRes}`);
  }

  console.log("\n=================================================");
  console.log(" ✨ All Verification Tests Complete!");
  console.log("=================================================");
  process.exit(0);
})();
