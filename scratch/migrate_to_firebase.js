const fs = require("fs");
const path = require("path");
const { syncAccountToFirestore, fetchAccountsFromFirestore } = require("../lib/firebaseClient");

(async () => {
  console.log("=======================================================");
  console.log(" 🚀 YAPCASH FIREBASE FIRESTORE 14-ACCOUNT RE-MIGRATION");
  console.log("=======================================================\n");

  const snapshotFile = path.join(__dirname, "snapshot_14_accounts.json");
  if (!fs.existsSync(snapshotFile)) {
    console.error("❌ snapshot_14_accounts.json not found!");
    process.exit(1);
  }

  const raw = fs.readFileSync(snapshotFile, "utf-8");
  const accounts = JSON.parse(raw);

  // Sort accounts numerically: account_1, account_2, ... account_14
  accounts.sort((a, b) => {
    const numA = parseInt((a.accountId || "").replace(/\D/g, ""), 10) || 0;
    const numB = parseInt((b.accountId || "").replace(/\D/g, ""), 10) || 0;
    return numA - numB;
  });

  console.log(`📦 Seeding ${accounts.length} accounts to Firebase Firestore...`);

  let successCount = 0;
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const orderNum = parseInt((acc.accountId || "").replace(/\D/g, ""), 10) || (i + 1);
    acc.order = orderNum;
    console.log(`⏳ [Order: ${orderNum}] Syncing ${acc.accountId} (${acc.email})...`);
    const ok = await syncAccountToFirestore(acc);
    if (ok) {
      console.log(`✅ [Firestore] ${acc.accountId} (Order: ${orderNum}) saved to Firebase Cloud!`);
      successCount++;
    } else {
      console.log(`⚠️ [Firestore] ${acc.accountId} sync failed`);
    }
  }

  console.log("\n🔍 Verifying cloud accounts in Firebase Firestore...");
  const cloudAccounts = await fetchAccountsFromFirestore();
  console.log(`📊 Cloud Accounts Hydrated: ${cloudAccounts.length}/14 Accounts in Firebase Firestore`);

  console.log("\n=======================================================");
  console.log(" 🏆 MIGRATION COMPLETE: All 14 accounts in Firebase!");
  console.log("=======================================================");
  process.exit(0);
})();
