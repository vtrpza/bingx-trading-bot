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
    // For API responses with format { success: true, data: {...} }, return the data field directly
    if (response.data && response.data.success && response.data.data !== undefined) {
      // Preserve axios response structure but replace data content
      return {
        ...response,
        data: response.data.data
      }
    }
    // For other responses, return as-is
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

  async getAllAssets(params?: {
    sortBy?: string
    sortOrder?: 'ASC' | 'DESC'
    search?: string
    status?: string
  }): Promise<{
    assets: Asset[]
    count: number
    executionTime: string
    lastUpdated: string
  }> {
    return axiosInstance.get('/assets/all', { params })
  },

  async getAsset(symbol: string): Promise<Asset> {
    return axiosInstance.get(`/assets/${symbol}`)
  },

  async refreshAssetsDelta(onProgress?: (data: any) => void): Promise<{ message: string; created: number; updated: number; total: number; processed: number; skipped: number; sessionId: string; deltaMode?: string }> {
    const sessionId = `delta_refresh_${Date.now()}`;
    
    return new Promise((resolve, reject) => {
      let eventSource: EventSource | null = null;
      
      // Connect to SSE for progress updates
      if (onProgress) {
        const sseUrl = `/api/assets/refresh/progress/${sessionId}`;
        console.log('🔌 Delta refresh SSE:', sseUrl);
        eventSource = new EventSource(sseUrl);
        
        eventSource.onopen = () => {
          console.log('✅ Delta SSE connected');
        };

        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log('📡 Delta SSE received:', data);
            
            if (data.type === 'heartbeat') {
              console.log('💓 Delta heartbeat');
              return;
            }
            
            if (data.type !== 'connected') {
              console.log('🔄 Delta progress to UI:', data);
              onProgress(data);
            }
            
            if (data.type === 'completed' || data.type === 'error') {
              console.log('🔚 Delta SSE closing...');
              eventSource?.close();
            }
          } catch (error) {
            console.error('❌ Delta SSE parse error:', error, 'Raw data:', event.data);
          }
        };
        
        eventSource.onerror = (error) => {
          console.error('❌ Delta SSE connection error:', error);
        };
      }
      
      // Start delta refresh
      setTimeout(async () => {
        try {
          console.log('🚀 Starting delta refresh with sessionId:', sessionId);
          const response = await axiosInstance.post('/assets/refresh/delta', { sessionId });
          console.log('✅ Delta refresh response:', response.data);
          resolve(response.data);
        } catch (error) {
          console.error('❌ Delta refresh error:', error);
          eventSource?.close();
          reject(error);
        }
      }, 500);
    });
  },

  async refreshAssets(onProgress?: (data: any) => void): Promise<{ message: string; created: number; updated: number; total: number; processed: number; skipped: number; sessionId: string }> {
    const sessionId = `refresh_${Date.now()}`;
    
    return new Promise((resolve, reject) => {
      let eventSource: EventSource | null = null;
      
      // Connect to SSE for progress updates
      if (onProgress) {
        // Usar URL relativa para evitar problemas de CORS
        const sseUrl = `/api/assets/refresh/progress/${sessionId}`;
        console.log('🔌 Conectando SSE:', sseUrl);
        eventSource = new EventSource(sseUrl);
        
        eventSource.onopen = () => {
          console.log('✅ SSE conectado com sucesso!');
        };

        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log('📡 SSE recebido:', data);
            
            // Skip connection and heartbeat messages, but log heartbeat for debugging
            if (data.type === 'heartbeat') {
              console.log('💓 Heartbeat recebido - conexão SSE ativa');
              return;
            }
            
            if (data.type !== 'connected') {
              console.log('🔄 Enviando progresso para UI:', data);
              onProgress(data);
            }
            
            // Close connection when completed
            if (data.type === 'completed' || data.type === 'error') {
              console.log('🔚 SSE finalizando...');
              eventSource?.close();
            }
          } catch (error) {
            console.error('❌ Erro ao parsear SSE:', error, 'Raw data:', event.data);
          }
        };
        
        eventSource.onerror = (error) => {
          console.error('❌ SSE erro de conexão:', error);
          console.log('📊 SSE readyState:', eventSource?.readyState);
          // Não fechar automaticamente para permitir reconexão
        };
      }
      
      // Wait a bit for SSE connection to establish, then start refresh
      setTimeout(async () => {
        try {
          console.log('🚀 Iniciando refresh com sessionId:', sessionId);
          const response = await axiosInstance.post('/assets/refresh', { sessionId });
          console.log('✅ Refresh response:', response.data);
          resolve(response.data);
        } catch (error) {
          console.error('❌ Erro no refresh:', error);
          eventSource?.close();
          reject(error);
        }
      }, 500); // 500ms delay para garantir conexão SSE
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

  async invalidateCache(): Promise<{
    message: string
    timestamp: string
  }> {
    console.log('🔄 API: Invalidating server cache')
    try {
      const response = await axiosInstance.post('/assets/cache/invalidate')
      console.log('✅ API: Cache invalidation response:', response.data)
      return response.data
    } catch (error: any) {
      console.error('❌ API: Cache invalidation error:', error)
      throw error
    }
  },

  async clearAllAssets(): Promise<{
    message: string
    deletedCount: number
  }> {
    console.log('🔄 API: Chamando DELETE /assets/clear')
    try {
      const response = await axiosInstance.delete('/assets/clear')
      console.log('✅ API: Resposta completa recebida:', response)
      console.log('✅ API: response.data:', response.data)
      console.log('✅ API: response.status:', response.status)
      
      // O response interceptor já extraiu response.data.data, então response.data contém { message, deletedCount }
      const result = response.data
      console.log('✅ API: Resultado final:', result)
      return result
    } catch (error: any) {
      console.error('❌ API: Erro ao limpar banco:', error)
      console.error('❌ API: error.response:', error.response)
      console.error('❌ API: error.message:', error.message)
      throw error
    }
  },

  // Trading Bot
  async getBotStatus(): Promise<any> {
    // The response interceptor already extracts the data field for us
    return axiosInstance.get('/trading/parallel-bot/status')
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

  // Parallel Bot Specific APIs
  async getParallelBotStatus(): Promise<BotStatus & {
    architecture: 'parallel'
    managedPositions: number
    positionMetrics: any
    immediateExecution: boolean
  }> {
    return axiosInstance.get('/trading/parallel-bot/status')
  },

  async getManagedPositions(): Promise<any[]> {
    return axiosInstance.get('/trading/parallel-bot/positions')
  },

  async getPositionMetrics(): Promise<{
    totalPositions: number
    activePositions: number
    closedPositions: number
    totalPnL: number
    winRate: number
    avgHoldTime: number
    stopLossTriggered: number
    takeProfitTriggered: number
    manuallyClosedCount: number
  }> {
    return axiosInstance.get('/trading/parallel-bot/position-metrics')
  },

  async signalClosePosition(symbol: string): Promise<{ message: string }> {
    return axiosInstance.post(`/trading/parallel-bot/positions/${symbol}/close`)
  },

  async signalCloseAllPositions(): Promise<{ message: string }> {
    return axiosInstance.post('/trading/parallel-bot/positions/close-all')
  },

  async confirmPositionClosed(symbol: string, actualPnl?: number): Promise<{ message: string }> {
    return axiosInstance.post(`/trading/parallel-bot/positions/${symbol}/confirm-closed`, { actualPnl })
  },

  async executeSignalImmediately(symbol: string): Promise<{
    taskId: string | null
    message: string
  }> {
    return axiosInstance.post(`/trading/parallel-bot/execute-immediate/${symbol}`)
  },

  async setImmediateExecutionMode(enabled: boolean): Promise<{ message: string }> {
    return axiosInstance.post('/trading/parallel-bot/immediate-execution', { enabled })
  },

  async getEnhancedTradingStats(period?: string): Promise<{
    period: string
    trading: {
      totalTrades: number
      winningTrades: number
      losingTrades: number
      winRate: string
      totalPnl: string
      totalVolume: string
      averagePnl: string
    }
    positions: {
      current: number
      metrics: any
    }
    bot: {
      isRunning: boolean
      architecture: 'parallel'
      immediateExecution: boolean
    }
  }> {
    return axiosInstance.get('/trading/parallel-bot/enhanced-stats', { params: { period } })
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