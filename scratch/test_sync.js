const { fetchWithRetry } = require("../lib/http");

(async () => {
  console.log("Testing POST to http://localhost:8000/api/sync-token...");
  const res = await fetchWithRetry("http://localhost:8000/api/sync-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-sync-key": "yapcash_secret_2026",
    },
    body: JSON.stringify({
      refreshToken: "invalid_test_token_123",
      accessToken: null
    }),
  }).catch(err => ({ ok: false, statusText: err.message }));

  console.log("HTTP Status:", res.status);
  const data = await res.json().catch(() => ({}));
  console.log("Response Body:", data);
})();
