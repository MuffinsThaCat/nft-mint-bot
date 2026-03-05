# 🚀 Quick Start Guide

Get your NFT mint bot running in 5 minutes.

## Step 1: Prerequisites

```bash
# Check Node.js version (must be 20+)
node --version

# If not installed, get it from https://nodejs.org/
```

## Step 2: Setup

```bash
cd nft-mint-bot

# Install dependencies
npm install

# Copy environment file
cp .env.example .env
```

## Step 3: Configure

Edit `.env` file:

```env
# Required (get from @BotFather on Telegram)
BOT_TOKEN=7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw

# Your Telegram user ID (get from @userinfobot)
ALLOWED_USER_IDS=123456789

# Strong password for encrypting private keys (min 12 chars)
DB_PASSWORD=MySecurePassword123!

# Recommended for reliability
ALCHEMY_KEY=your_alchemy_key_here
ETHERSCAN_API_KEY=your_etherscan_key_here
```

## Step 4: Start Bot

```bash
# Development mode (see logs)
npm run dev
```

You should see:
```
✅ Bot is running and ready to receive commands
Press Ctrl+C to stop
```

## Step 5: First Commands

Open Telegram and message your bot:

```
/start
/chain ethereum
/genwallets 5
```

Bot will generate 5 wallets and show you the mnemonic. **SAVE IT!**

## Step 6: Fund Wallets

From your master wallet, send ETH to the bot wallets:

```
/wallets         # Get wallet addresses
```

Send 0.01 ETH to each address (or use `/fund` command if you have master wallet private key).

## Step 7: First Mint (Test)

```bash
# Analyze an NFT contract
/analyze 0x1234...

# Set it as active
/setcontract 0x1234...

# Run simulation (checks balances, gas, simulates mint)
/simulate

# If all green, execute
/mintall
```

## 🎯 Production Deployment

For 24/7 operation:

```bash
# Install PM2
npm install -g pm2

# Start with PM2
npm run pm2

# View logs
pm2 logs nft-mint-bot

# Monitor
pm2 monit

# Auto-restart on server reboot
pm2 startup
pm2 save
```

## 🔥 Pro Tips

### Gas Strategy for Competitive Mints

```bash
# Check current gas
/gas

# If network is hot, use aggressive mode
/setgas aggressive

# Or set ceiling to avoid overpaying
/setmaxgas 100
```

### Schedule for Exact Block

```bash
/analyze <contract>
/simulate
/schedule 18500000    # Block when mint opens
# Bot will auto-execute when block is reached
```

### Whitelist Mints

```bash
# Prepare CSV:
# address,proof
# 0x123...,["0xabc...","0xdef..."]

/uploadwl
# Send CSV file
/wlcheck    # Verify proofs loaded
/mintall
```

### Kill Switch

If something goes wrong during mint:

```bash
/stop    # Emergency abort
```

## 🐛 Common Issues

**"Unauthorized access"**
- Check your user ID is in ALLOWED_USER_IDS
- Get your ID from @userinfobot

**"BOT_TOKEN is required"**
- Make sure .env file exists
- Check BOT_TOKEN is set correctly

**"Password must be at least 12 characters"**
- Use a longer DB_PASSWORD
- Mix letters, numbers, symbols

**"No valid RPC providers"**
- Add ALCHEMY_KEY to .env
- Or bot will use public RPCs (slower, rate-limited)

**"Invalid address" when analyzing**
- Make sure address starts with 0x
- Full address, not shortened

## 📚 Next Steps

- Read [README.md](./README.md) for full documentation
- Check `/help` in Telegram for all commands
- Test on a low-value mint first
- Monitor gas prices before competitive mints

---

**You're ready to mint! 🚀**

Questions? Issues? Check the README or logs:
```bash
pm2 logs nft-mint-bot --lines 100
```
