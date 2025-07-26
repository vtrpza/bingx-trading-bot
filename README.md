# BingX Trading Bot

A professional day trading bot for BingX perpetual futures with VST demo trading support.

## 🚀 Features

### Asset Analysis Tab
- Complete BingX asset database with real-time data
- Advanced table with sorting, filtering, search, and pagination
- Market statistics and top movers
- One-click data refresh from BingX API

### Trading Bot Tab
- Automated perpetual futures trading in demo mode (VST)
- Real-time technical analysis with multiple indicators:
  - Moving Averages (EMA 9, 21)
  - RSI (Relative Strength Index)
  - Volume analysis and spike detection
  - Crossover detection
- Intelligent signal generation with strength scoring
- Risk management with stop loss, take profit, and trailing stop
- Real-time position monitoring and P&L tracking
- Trading statistics and performance analytics

### Technical Features
- Full integration with BingX API (no simulated data)
- Real-time WebSocket connections for live data
- PostgreSQL database for asset and trade storage
- TypeScript for type safety
- Modern React frontend with Tailwind CSS
- RESTful API with comprehensive error handling

## 🛠 Tech Stack

**Backend:**
- Node.js + Express + TypeScript
- PostgreSQL with Sequelize ORM
- WebSocket for real-time data
- Winston for logging
- Comprehensive API validation

**Frontend:**
- React 18 + TypeScript
- Tailwind CSS for styling
- React Query for data fetching
- React Router for navigation
- Real-time WebSocket integration

## 📋 Prerequisites

- Node.js 18+ 
- PostgreSQL database
- BingX API credentials

## 🚀 Quick Start

### 1. Clone and Install

```bash
git clone <repository-url>
cd bingx-trading-bot
npm run install:all
```

### 2. Environment Setup

Create environment files:

**Server (.env):**
```env
# BingX API Configuration
BINGX_API_KEY=your_api_key_here
BINGX_SECRET_KEY=your_secret_key_here
BINGX_API_URL=https://open-api.bingx.com
BINGX_WS_URL=wss://open-api-ws.bingx.com/market

# Server Configuration
PORT=3001
NODE_ENV=development

# Database Configuration
DATABASE_URL=postgresql://username:password@localhost:5432/bingx_trading_bot

# Trading Configuration
DEMO_MODE=true
MAX_CONCURRENT_TRADES=3
DEFAULT_POSITION_SIZE=100
```

### 3. Database Setup

```bash
# Create PostgreSQL database
createdb bingx_trading_bot

# The application will automatically create tables on first run
```

### 4. Run Development

```bash
# Start both backend and frontend
npm run dev

# Or run separately:
npm run server:dev  # Backend on port 3001
npm run client:dev  # Frontend on port 3000
```

### 5. Initial Setup

1. Open http://localhost:3000
2. Go to Asset Analysis tab
3. Click "Refresh Data" to populate the database
4. Go to Trading Bot tab to configure and start the bot

## 🌐 Deployment

### Vercel Deployment

1. Install Vercel CLI: `npm i -g vercel`
2. Login: `vercel login`
3. Deploy: `vercel --prod`
4. Set environment variables in Vercel dashboard

### Render Deployment

1. Connect your GitHub repository to Render
2. Create PostgreSQL database service
3. Create web services using the provided `render.yaml`
4. Set required environment variables

### Environment Variables

Required for production:
- `BINGX_API_KEY`: Your BingX API key
- `BINGX_SECRET_KEY`: Your BingX secret key
- `DATABASE_URL`: PostgreSQL connection string
- `NODE_ENV=production`
- `DEMO_MODE=true` (recommended for safety)

## 🔧 Configuration

### Bot Configuration

The trading bot can be configured through the web interface:

- **Max Concurrent Trades**: Maximum number of simultaneous positions
- **Position Size**: Default position size in USDT/VST
- **Stop Loss %**: Stop loss percentage
- **Take Profit %**: Take profit percentage
- **Trailing Stop %**: Trailing stop percentage
- **Min Volume**: Minimum 24h volume for symbol selection

### Technical Indicators

Default settings (customizable via API):
- **EMA Periods**: 9 and 21
- **RSI Period**: 14
- **Volume Period**: 20
- **RSI Oversold**: 30
- **RSI Overbought**: 70

## 📊 API Endpoints

### Assets
- `GET /api/assets` - Get paginated assets with filters
- `POST /api/assets/refresh` - Refresh assets from BingX
- `GET /api/assets/stats/overview` - Get asset statistics

### Trading
- `GET /api/trading/bot/status` - Get bot status
- `POST /api/trading/bot/start` - Start trading bot
- `POST /api/trading/bot/stop` - Stop trading bot
- `GET /api/trading/positions` - Get active positions
- `GET /api/trading/trades/history` - Get trade history

### Market Data
- `GET /api/market-data/ticker/:symbol` - Get ticker data
- `GET /api/market-data/klines/:symbol` - Get candlestick data
- `GET /api/market-data/indicators/:symbol` - Get technical indicators
- `GET /api/market-data/signal/:symbol` - Generate trading signal

## 🚨 Safety Features

- **Demo Mode**: All trading uses VST (Virtual USDT) by default
- **Data Validation**: Comprehensive input validation and error handling
- **Real Data Only**: No fallback to simulated data - shows warnings if data unavailable
- **Risk Management**: Built-in stop loss, take profit, and position sizing
- **Rate Limiting**: Respects BingX API rate limits

## 📈 Trading Strategy

The bot uses a multi-indicator approach:

1. **Trend Analysis**: EMA crossovers (9/21 periods)
2. **Momentum**: RSI for overbought/oversold conditions
3. **Volume Confirmation**: Volume spikes for signal validation
4. **Signal Strength**: Combined scoring (60%+ threshold)
5. **Risk Management**: Automatic stop loss and take profit

## 🔍 Monitoring

- Real-time position monitoring
- Live P&L tracking
- Trading statistics and analytics
- WebSocket-based live updates
- Comprehensive logging

## 🤝 Support

For issues and questions:
1. Check the logs for error details
2. Verify BingX API credentials and permissions
3. Ensure database connectivity
4. Check network connectivity to BingX endpoints

## ⚠️ Disclaimer

This is a demo trading bot for educational purposes. Always test thoroughly in demo mode before considering live trading. Cryptocurrency trading involves substantial risk of loss.

## 📄 License

This project is for educational and personal use only.