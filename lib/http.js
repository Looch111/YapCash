try { require("dns").setDefaultResultOrder("ipv4first"); } catch (_) {}
const { ProxyAgent } = require("undici");

/**
 * Enterprise HTTP client wrapper with automatic retry, exponential backoff, proxy support, and network error handling.
 */
async function fetchWithRetry(url, options = {}, retries = 3, backoffMs = 500) {
  const fetchOptions = { ...options };

  // Set default 20-second request timeout if not already set
  if (!fetchOptions.signal && typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    fetchOptions.signal = AbortSignal.timeout(20000);
  }

  // If a proxy URL is specified, attach undici ProxyAgent dispatcher
  if (options.proxy && !fetchOptions.dispatcher) {
    try {
      fetchOptions.dispatcher = new ProxyAgent(options.proxy);
    } catch (proxyErr) {
      console.warn(`⚠️ Invalid proxy configuration (${options.proxy}): ${proxyErr.message}`);
    }
  }

  // Remove custom non-standard option before passing to fetch
  delete fetchOptions.proxy;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, fetchOptions);


      // If rate-limited (429) or server error (502, 503, 504), retry after delay
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        const retryAfter = response.headers.get("retry-after");
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : backoffMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return response;
    } catch (err) {
      if (attempt < retries) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw new Error(`Network request failed after ${retries} attempts: ${err.message}`);
      }
    }
  }
}

module.exports = {
  fetchWithRetry,
};
