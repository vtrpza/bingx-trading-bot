# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Core Development
- `npm run dev` - Start both backend and frontend in development mode
- `npm run server:dev` - Start only backend server on port 3001 (using tsx watch)
- `npm run client:dev` - Start only frontend on port 3000 (using Vite)
- `npm run build` - Build both frontend and backend for production
- `npm run start` - Start production server
- `npm run install:all` - Install dependencies for both frontend and backend

### Backend Only
- `cd server && npm run test` - Run backend tests with Jest
- `cd server && npm run build` - Build TypeScript backend
- `cd server && npm start` - Start production backend

### Frontend Only  
- `cd client && npm run lint` - Run ESLint for frontend code
- `cd client && npm run build` - Build frontend with Vite
- `cd client && npm run preview` - Preview production build

## Architecture Overview

### Project Structure
- **Root**: Monorepo with both client and server
- **Client**: React 18 + TypeScript frontend using Vite
- **Server**: Node.js + Express + TypeScript backend with PostgreSQL/SQLite

### Core Trading System Architecture

#### 1. Dual Bot System
The project implements two trading bot architectures:

**Legacy TradingBot** (`server/src/trading/bot.ts`):
- Single-threaded sequential processing
- Basic signal generation and execution
- Process tracking with flow state monitoring
- Suitable for simple trading strategies

**ParallelTradingBot** (`server/src/trading/ParallelTradingBot.ts`):
- Multi-threaded parallel processing architecture
- Advanced component-based design with:
  - `SignalWorkerPool` - Parallel signal generation
  - `PrioritySignalQueue` - Smart signal queuing
  - `TradeExecutorPool` - Concurrent trade execution
  - `MarketDataCache` - Intelligent data caching
  - `PositionManager` - Real-time position monitoring
  - `RiskManager` - Comprehensive risk controls

#### 2. Key Trading Components

**Signal Generation** (`server/src/trading/signalGenerator.ts`):
- Technical indicators: RSI, EMA, Volume analysis
- Multi-timeframe analysis
- Configurable signal strength thresholds
- HOLD/BUY/SELL signal classification

**Risk Management** (`server/src/trading/RiskManager.ts`):
- Position sizing with volatility-based calculations
- Daily P&L limits and drawdown protection
- Risk/reward ratio validation
- Emergency stop mechanisms

**Position Management** (`server/src/trading/PositionManager.ts`):
- Real-time position monitoring
- Stop-loss and take-profit management
- Trailing stop functionality
- Position closure signaling

#### 3. API Integration
**BingX Client** (`server/src/services/bingxClient.ts`):
- RESTful API integration for trading operations
- WebSocket connections for real-time data
- Rate limiting and error handling
- Demo mode (VST) trading support

**API Request Manager** (`server/src/services/APIRequestManager.ts`):
- Priority-based request queuing
- Rate limiting compliance
- Automatic retry mechanisms
- Request deduplication

#### 4. Data Management
**Database Models**:
- `Trade` - Trade execution records
- `Asset` - Symbol information and metadata
- PostgreSQL for production, SQLite for development

**Market Data Caching**:
- Intelligent caching with TTL management
- Price change detection and alerts
- Volume-based symbol filtering

### Configuration Management

**Trading Bot Configuration**:
- Risk parameters (stop-loss, take-profit, position sizing)
- Technical indicator settings (RSI periods, EMA periods)
- Execution parameters (scan intervals, concurrent trades)
- Performance optimization settings (worker pools, caching)

**Environment Variables**:
- `DEMO_MODE=true` - Enable VST demo trading
- `BINGX_API_KEY` / `BINGX_SECRET_KEY` - API credentials
- `DATABASE_URL` - Database connection string
- `MAX_CONCURRENT_TRADES` - Position limits
- `DEFAULT_POSITION_SIZE` - Trade sizing

### Real-time Features

**WebSocket Integration** (`server/src/services/websocket.ts`):
- Live trading data streams
- Real-time position updates
- Activity event broadcasting
- Client-server synchronization

**Process Monitoring**:
- Trading flow state tracking
- Performance metrics collection
- Activity timeline with categorized events
- Bottleneck identification and reporting

### Frontend Architecture

**Key Components**:
- `TradingPage.tsx` - Main trading interface
- `BotControls.tsx` - Bot configuration and controls
- `PositionsTable.tsx` - Real-time position monitoring
- `TradingFlowMonitor.tsx` - Process visualization
- `RealTimeSignals.tsx` - Live signal display

**State Management**:
- React Query for API data fetching
- WebSocket hooks for real-time updates
- Zustand for local state management
- Context providers for configuration

### Testing Strategy
- Backend: Jest unit tests for core trading logic
- Integration tests for API endpoints
- Mock trading environment for development
- Performance testing for parallel processing

## Important Implementation Notes

1. **Default to ParallelTradingBot**: New features should integrate with the parallel architecture
2. **Risk Management**: All trading operations must go through risk validation
3. **Demo Mode**: Default to VST trading for safety
4. **Error Handling**: Comprehensive error handling with fallback mechanisms
5. **Rate Limiting**: All API calls must respect BingX rate limits
6. **Real-time Updates**: Use WebSocket for live data, avoid polling
7. **Configuration**: Use environment variables for sensitive data
8. **Logging**: Structured logging with Winston for debugging and monitoring

## Trading Safety
- All trading uses VST (Virtual USDT) by default in demo mode
- Real API integration with BingX, no simulated data
- Risk management controls prevent excessive losses
- Position limits and daily loss limits enforced
- Stop-loss and take-profit orders automatically placed