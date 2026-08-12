/**
 * Lightweight, zero-dependency Node.js HTTP & HTTPS Tunneling Proxy Server
 * Integrated into YapCash Multi-Account Runner (2-in-1 Daemon)
 */

const http = require("http");
const net = require("net");
const { URL } = require("url");

let serverInstance = null;
let startTime = null;
let totalRequests = 0;

const proxyStats = {
  running: false,
  host: "0.0.0.0",
  port: 8080,
  user: null,
  pass: null,
  publicIp: "Detecting...",
  country: "Unknown",
  countryCode: "",
  flag: "🌐",
  city: "Unknown",
  org: "Unknown",
};

// Convert ISO 2-letter country code (US, GB, DE) to flag emoji (🇺🇸, 🇬🇧, 🇩🇪)
function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return "🌐";
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

// Fetch public IP and country geolocation info on startup
async function detectGeoLocation() {
  try {
    const { fetchWithRetry } = require("./lib/http");
    const res = await fetchWithRetry("http://ip-api.com/json/?fields=status,message,country,countryCode,city,org,query", {}, 2, 1000);
    if (res && res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.status === "success" || data.query) {
        proxyStats.publicIp = data.query || proxyStats.publicIp;
        proxyStats.country = data.country || "Unknown";
        proxyStats.countryCode = data.countryCode || "";
        proxyStats.flag = getFlagEmoji(data.countryCode);
        proxyStats.city = data.city || "Unknown";
        proxyStats.org = data.org || "Unknown";
        return;
      }
    }
  } catch (_) {}

  // Fallback IP detection
  try {
    const { fetchWithRetry } = require("./lib/http");
    const res = await fetchWithRetry("https://api.ipify.org?format=json", {}, 2, 1000);
    if (res && res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.ip) {
        proxyStats.publicIp = data.ip;
      }
    }
  } catch (_) {}
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    port: parseInt(process.env.PROXY_PORT || process.env.PORT, 10) || 8080,
    host: process.env.PROXY_HOST || process.env.HOST || "0.0.0.0",
    user: process.env.PROXY_USER || "admin",
    pass: process.env.PROXY_PASS || "yapcash123",
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) options.port = parseInt(args[++i], 10);
    if (args[i] === "--host" && args[i + 1]) options.host = args[++i];
    if (args[i] === "--user" && args[i + 1]) options.user = args[++i];
    if (args[i] === "--pass" && args[i + 1]) options.pass = args[++i];
  }
  return options;
}

function isAuthenticated(req, user, pass) {
  if (!user || !pass) return true;

  const authHeader = req.headers["proxy-authorization"];
  if (!authHeader) return false;

  const [type, credentials] = authHeader.split(" ");
  if (type !== "Basic" || !credentials) return false;

  const decoded = Buffer.from(credentials, "base64").toString("utf-8");
  const [u, p] = decoded.split(":");
  return u === user && p === pass;
}

function startProxyServer(customOpts = {}) {
  if (proxyStats.running && serverInstance) {
    return proxyStats;
  }

  const opts = { ...parseArgs(), ...customOpts };
  proxyStats.host = opts.host;
  proxyStats.port = opts.port;
  proxyStats.user = opts.user;
  proxyStats.pass = opts.pass;

  startTime = Date.now();

  serverInstance = http.createServer((req, res) => {
    totalRequests++;

    if (!isAuthenticated(req, opts.user, opts.pass)) {
      res.writeHead(407, {
        "Proxy-Authenticate": 'Basic realm="Yapcah Proxy"',
        "Content-Type": "text/plain",
      });
      return res.end("407 Proxy Authentication Required\n");
    }

    try {
      const targetUrl = new URL(req.url);
      const reqOptions = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: { ...req.headers },
      };

      delete reqOptions.headers["proxy-authorization"];

      const proxyReq = http.request(reqOptions, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      });

      proxyReq.on("error", (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end(`502 Bad Gateway: ${err.message}\n`);
        }
      });

      req.pipe(proxyReq, { end: true });
    } catch (err) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`400 Bad Request: ${err.message}\n`);
    }
  });

  serverInstance.on("clientError", (err, socket) => {
    if (socket.writable) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    }
    socket.destroy();
  });

  serverInstance.on("connect", (req, clientSocket, head) => {
    totalRequests++;
    clientSocket.on("error", () => {});

    if (!isAuthenticated(req, opts.user, opts.pass)) {
      clientSocket.write(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          'Proxy-Authenticate: Basic realm="Yapcah Proxy"\r\n' +
          "Content-Type: text/plain\r\n\r\n" +
          "407 Proxy Authentication Required\n"
      );
      clientSocket.end();
      return;
    }

    const [host, portStr] = req.url.split(":");
    const port = parseInt(portStr, 10) || 443;

    const serverSocket = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on("error", () => {
      try {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } catch (_) {}
    });
  });

  serverInstance.listen(opts.port, opts.host, () => {
    proxyStats.running = true;
    const authLabel = opts.user ? `Authenticated (${opts.user})` : "Public";
    console.log(`🚀 Yapcah Proxy Server running on http://${opts.host}:${opts.port} [${authLabel}]`);
    detectGeoLocation().catch(() => {});
  });

  serverInstance.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`⚠️ Proxy port ${opts.port} already in use. Proxy server running externally.`);
      proxyStats.running = true;
    } else {
      console.error(`❌ Proxy server error: ${err.message}`);
    }
  });

  return proxyStats;
}

function formatDuration(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  return `${hours}h ${minutes}m ${seconds}s`;
}

function getProxyInfo() {
  const uptimeMs = startTime ? Date.now() - startTime : 0;
  const authPart = proxyStats.user ? `${proxyStats.user}:${proxyStats.pass}@` : "";
  const ip = proxyStats.publicIp !== "Detecting..." ? proxyStats.publicIp : "127.0.0.1";
  
  return {
    ...proxyStats,
    uptime: formatDuration(uptimeMs),
    totalRequests,
    proxyUrl: `http://${authPart}${ip}:${proxyStats.port}`,
    localProxyUrl: `http://${authPart}127.0.0.1:${proxyStats.port}`,
  };
}

// Support CLI execution directly
if (require.main === module) {
  startProxyServer();
}

module.exports = {
  startProxyServer,
  getProxyInfo,
};
