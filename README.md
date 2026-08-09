# YapCash Multi-Account Telegram Automation Daemon

Autonomous Node.js multi-account XP farming and gift card auto-redemption daemon with real-time Telegram Bot notifications.

## Features
- **Multi-Account Proxy Daemon**: Rotates through configured accounts via HTTP/SOCKS proxies.
- **Telegram Bot Integration**: Instant gift card winner alerts, per-account progress updates, and clean daily cycle reports.
- **Interactive Inline Buttons**: Confirm and mark gift cards claimed directly within Telegram.
- **Auto Redemption**: Triggers reward pack redemptions automatically and records wins to `wins.json`.

## Quick Start
```bash
# 1. Install dependencies
npm install

# 2. Configure accounts.json & telegram.json
cp accounts.json.example accounts.json
cp telegram.json.example telegram.json

# 3. Check status
node runner.js status

# 4. Run single cycle
node runner.js run-all

# 5. Start 24/7 daemon
node runner.js
```
