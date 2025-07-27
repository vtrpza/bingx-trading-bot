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
  PaginatedResponse,
  ActivityEvent
} from '../types'

const axiosInstance = axios.create({
  baseURL: '/api',
  timeout: 300000, // 5 minutes for refresh operations
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
    // Se a resposta tem o formato padrão { success: true, data: {...} }, extrair só os dados
    if (response.data && response.data.success && response.data.data !== undefined) {
      return { ...response, data: response.data.data }
    }
    // Caso contrário, retornar a resposta completa
    return response
  },
  (error) => {
    const message = error.response?.data?.error?.message || 
                   error.response?.data?.msg || 
                   error.message || 
                   'An error occurred'
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
    return axiosInstance.get('/assets', { params })
  },

  async getAsset(symbol: string): Promise<Asset> {
    return axiosInstance.get(`/assets/${symbol}`)
  },

  async refreshAssets(onProgress?: (data: any) => void): Promise<{ message: string; created: number; updated: number; total: number; processed: number; skipped: number; sessionId: string }> {
    const sessionId = `refresh_${Date.now()}`;
    
    return new Promise((resolve, reject) => {
      let eventSource: EventSource | null = null;
      
      // Connect to SSE for progress updates
      if (onProgress) {
        const baseURL = window.location.protocol === 'https:' ? 'https://localhost:3001' : 'http://localhost:3001'
        eventSource = new EventSource(`${baseURL}/api/assets/refresh/progress/${sessionId}`);
        
        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log('SSE received:', data);
            
            // Skip the initial connection message
            if (data.type !== 'connected') {
              onProgress(data);
            }
            
            // Close connection when completed
            if (data.type === 'completed' || data.type === 'error') {
              eventSource?.close();
            }
          } catch (error) {
            console.error('Failed to parse SSE data:', error);
          }
        };
        
        eventSource.onerror = (error) => {
          console.error('SSE connection error:', error);
          eventSource?.close();
        };
      }
      
      // Wait a bit for SSE connection to establish, then start refresh
      setTimeout(async () => {
        try {
          const response = await axiosInstance.post('/assets/refresh', { sessionId });
          resolve(response.data);
        } catch (error) {
          eventSource?.close();
          reject(error);
        }
      }, 100); // 100ms delay
    });
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

  async getBotLogs(params?: {
    limit?: number
    level?: 'all' | 'error'
  }): Promise<{
    timestamp: string
    level: string
    message: string
    service: string
  }[]> {
    return axiosInstance.get('/trading/bot/logs', { params })
  },

  async updateBotConfig(config: Partial<BotConfig>): Promise<{ message: string; config: Partial<BotConfig> }> {
    return axiosInstance.put('/trading/bot/config', config)
  },

  async getBotFlowState(): Promise<{
    currentStep: string
    steps: any[]
    activeSignals: any[]
    executionQueue: any[]
    metrics: any
    lastUpdate: number
  }> {
    return axiosInstance.get('/trading/bot/flow-state')
  },

  async getBotActivityEvents(limit?: number): Promise<ActivityEvent[]> {
    return axiosInstance.get('/trading/bot/activity-events', { params: { limit } })
  },

  async getBotProcessMetrics(): Promise<{
    scanningRate: number
    signalGenerationRate: number
    executionSuccessRate: number
    averageProcessingTime: {
      scanning: number
      analysis: number
      decision: number
      execution: number
    }
    performance: {
      totalScanned: number
      signalsGenerated: number
      tradesExecuted: number
      errors: number
    }
    bottlenecks: string[]
  }> {
    return axiosInstance.get('/trading/bot/process-metrics')
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
    return axiosInstance.get('/trading/trades/history', { params })
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
    // Enhanced data from parallel bot
    positions?: {
      currentActive: number
      metrics: {
        totalPositions: number
        activePositions: number
        closedPositions: number
        totalPnL: number
        winRate: number
        avgHoldTime: number
        stopLossTriggered: number
        takeProfitTriggered: number
        manuallyClosedCount: number
      }
    }
    bot?: {
      isRunning: boolean
      architecture: 'parallel' | 'legacy'
      immediateExecution?: boolean
    }
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