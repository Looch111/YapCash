try { require("dns").setDefaultResultOrder("ipv4first"); } catch (_) {}
const { fetchWithRetry } = require("./http");

const SUPABASE_URL = "https://gidoyrbvnffcwbzzweqb.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpZG95cmJ2bmZmY3dienp3ZXFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwMjQ4NDgsImV4cCI6MjA5NDYwMDg0OH0._fHDzCrrQrq1UMJo5rtD_nS-1AqtPQK7gIFmq5xvGBs";

class SupabaseClient {
  constructor(account) {
    this.account = account; // { accountId, refreshToken, accessToken, proxy }
    this.baseUrl = SUPABASE_URL;
    this.anonKey = SUPABASE_ANON_KEY;
    this.accessToken = account.accessToken || null;
    this.refreshToken = account.refreshToken || null;
    this.proxy = account.proxy || null;
  }

  /**
   * Refreshes the OAuth access token using the stored refresh_token.
   */
  async refreshSession() {
    if (!this.refreshToken) {
      throw new Error(`No refresh token provided for account '${this.account.accountId}'`);
    }

    const response = await fetchWithRetry(`${this.baseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": this.anonKey,
      },
      body: JSON.stringify({ refresh_token: this.refreshToken }),
      proxy: this.proxy,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(`Token refresh failed for ${this.account.accountId}: ${data.error_description || data.message || response.statusText}`);
    }

    this.accessToken = data.access_token;
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
    }

    return {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      user: data.user,
    };
  }

  /**
   * Checks if the current access token is valid and not expired.
   */
  isAccessTokenValid() {
    if (!this.accessToken) return false;
    try {
      const payloadBase64 = this.accessToken.split(".")[1];
      const decoded = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf-8"));
      if (decoded.exp) {
        const nowSec = Math.floor(Date.now() / 1000);
        return decoded.exp > nowSec + 60; // valid if > 60 seconds remaining
      }
    } catch (_) {}
    return true;
  }

  /**
   * Helper to ensure a valid access token is present before executing requests.
   */
  async ensureAuthenticated() {
    if (!this.isAccessTokenValid()) {
      try {
        await this.refreshSession();
      } catch (err) {
        if (!this.accessToken) throw err;
      }
    }

    let user = null;
    if (this.accessToken) {
      try {
        const payloadBase64 = this.accessToken.split(".")[1];
        const decoded = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf-8"));
        user = {
          id: decoded.sub,
          email: decoded.email || decoded.user_metadata?.email || null,
        };
      } catch (_) {}
    }

    return {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      user: user,
    };
  }

  /**
   * Executes a Supabase RPC endpoint with auto-retry on expired tokens.
   */
  async rpc(functionName, payload = {}) {
    await this.ensureAuthenticated();

    let response = await this._callRpc(functionName, payload);

    // If 401 Unauthorized, attempt a single token refresh and retry
    if (response.status === 401) {
      await this.refreshSession();
      response = await this._callRpc(functionName, payload);
    }

    const result = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMsg = result?.message || result?.error || `HTTP ${response.status} ${response.statusText}`;
      throw new Error(`RPC '${functionName}' failed: ${errorMsg}`);
    }

    return result;
  }

  async _callRpc(functionName, payload) {
    return fetchWithRetry(`${this.baseUrl}/rest/v1/rpc/${functionName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": this.anonKey,
        "Authorization": `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(payload),
      proxy: this.proxy,
    });
  }

  /**
   * Fetches full account state from Supabase RPC / DB endpoints.
   */
  async getUserState(user = null) {
    await this.ensureAuthenticated();
    try {
      let userId = user?.id;
      if (!userId && this.accessToken) {
        try {
          const payloadBase64 = this.accessToken.split(".")[1];
          const decoded = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf-8"));
          userId = decoded.sub;
        } catch (_) {}
      }

      if (!userId) return null;

      const res = await fetchWithRetry(`${this.baseUrl}/rest/v1/profiles?id=eq.${userId}&select=id,total_xp,current_streak,last_activity_date,reward_country`, {
        method: "GET",
        headers: {
          "apikey": this.anonKey,
          "Authorization": `Bearer ${this.accessToken}`,
        },
        proxy: this.proxy,
      });
      if (res.ok) {
        const rows = await res.json();
        if (rows && rows.length > 0) return rows[0];
      }
    } catch (_) {}
    return null;
  }
}

module.exports = SupabaseClient;
