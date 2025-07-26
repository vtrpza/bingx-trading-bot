import axios from 'axios'
import type { 
  Asset, 
  Trade, 
  Position, 
  TradingSignal, 
  BotStatus, 
  BotConfig,
  MarketData,
  Candle,
  TechnicalIndicators,
  PaginatedResponse
} from '../types'

const axiosInstance = axios.create({
  baseURL: '/api',
  timeout: 30000,
})

// Request interceptor
axiosInstance.interceptors.request.use(
  (config) => {
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor
axiosInstance.interceptors.response.use(
  (response) => {
    return response.data
  },
  (error) => {
    const message = error.response?.data?.error?.message || error.message || 'An error occurred'
    throw new Error(message)
  }
)

export const api = {
  // Assets
  async getAssets(params?: {
    page?: number
    limit?: number
    sortBy?: string
    sortOrder?: 'ASC' | 'DESC'
    search?: string
    status?: string
  }): Promise<PaginatedResponse<Asset>> {
    const response = await axiosInstance.get('/assets', { params })
    return response.data
  },

  async getAsset(symbol: string): Promise<Asset> {
    return axiosInstance.get(`/assets/${symbol}`)
  },

  async refreshAssets(): Promise<{ message: string; created: number; updated: number; total: number }> {
    return axiosInstance.post('/assets/refresh')
  },

  async getAssetStats(): Promise<{
    totalAssets: number
    tradingAssets: number
    topGainers: Asset[]
    topLosers: Asset[]
    topVolume: Asset[]
  }> {
    return axiosInstance.get('/assets/stats/overview')
  },

  // Trading Bot
  async getBotStatus(): Promise<BotStatus> {
    return axiosInstance.get('/trading/bot/status')
  },

  async startBot(): Promise<{ message: string }> {
    return axiosInstance.post('/trading/bot/start')
  },

  async stopBot(): Promise<{ message: string }> {
    return axiosInstance.post('/trading/bot/stop')
  },

  async updateBotConfig(config: Partial<BotConfig>): Promise<{ message: string; config: Partial<BotConfig> }> {
    return axiosInstance.put('/trading/bot/config', config)
  },

  async getPositions(): Promise<Position[]> {
    return axiosInstance.get('/trading/positions')
  },

  async getOpenOrders(symbol?: string): Promise<any[]> {
    return axiosInstance.get('/trading/orders/open', { params: { symbol } })
  },

  async getTradeHistory(params?: {
    page?: number
    limit?: number
    symbol?: string
    status?: string
    startDate?: string
    endDate?: string
  }): Promise<PaginatedResponse<Trade>> {
    const response = await axiosInstance.get('/trading/trades/history', { params })
    return response
  },

  async getTradingStats(period?: string): Promise<{
    period: string
    totalTrades: number
    winningTrades: number
    losingTrades: number
    winRate: string
    totalPnl: string
    totalVolume: string
    averagePnl: string
    bestTrade: any
    worstTrade: any
  }> {
    return axiosInstance.get('/trading/stats', { params: { period } })
  },

  async placeOrder(orderData: {
    symbol: string
    side: 'BUY' | 'SELL'
    quantity: number
    type?: string
    price?: number
    stopLoss?: number
    takeProfit?: number
  }): Promise<any> {
    return axiosInstance.post('/trading/orders', orderData)
  },

  async cancelOrder(orderId: string, symbol: string): Promise<{ message: string }> {
    return axiosInstance.delete(`/trading/orders/${orderId}`, { params: { symbol } })
  },

  // Market Data
  async getTicker(symbol: string): Promise<MarketData> {
    return axiosInstance.get(`/market-data/ticker/${symbol}`)
  },

  async getKlines(symbol: string, interval?: string, limit?: number): Promise<Candle[]> {
    return axiosInstance.get(`/market-data/klines/${symbol}`, {
      params: { interval, limit }
    })
  },

  async getDepth(symbol: string, limit?: number): Promise<{
    bids: [number, number][]
    asks: [number, number][]
    lastUpdateId: number
  }> {
    return axiosInstance.get(`/market-data/depth/${symbol}`, { params: { limit } })
  },

  async getIndicators(symbol: string, params?: {
    interval?: string
    limit?: number
    ma1Period?: number
    ma2Period?: number
    rsiPeriod?: number
  }): Promise<{
    symbol: string
    interval: string
    indicators: TechnicalIndicators
    crossovers: any
    volumeAnalysis: any
    validation: any
    series: any
  }> {
    return axiosInstance.get(`/market-data/indicators/${symbol}`, { params })
  },

  async getSignal(symbol: string, interval?: string, limit?: number): Promise<TradingSignal> {
    return axiosInstance.get(`/market-data/signal/${symbol}`, {
      params: { interval, limit }
    })
  },

  async getMarketOverview(): Promise<{
    topGainers: any[]
    topLosers: any[]
    topVolume: any[]
    totalSymbols: number
    activeSymbols: number
  }> {
    return axiosInstance.get('/market-data/overview')
  },

  async subscribeToMarketData(subscription: {
    symbol: string
    type: string
    interval?: string
  }): Promise<{ message: string; subscription: any }> {
    return axiosInstance.post('/market-data/subscribe', subscription)
  },

  async unsubscribeFromMarketData(subscription: {
    symbol: string
    type: string
    interval?: string
  }): Promise<{ message: string; subscription: any }> {
    return axiosInstance.post('/market-data/unsubscribe', subscription)
  },
}