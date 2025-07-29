import { useEffect, useCallback, useMemo, lazy, Suspense } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { toast } from 'react-hot-toast'
import { api, apiUtils } from '../services/api'
import BotControls from '../components/BotControls'
import PositionsTable from '../components/PositionsTable'
import TradingStats from '../components/TradingStats'
import RealTimeSignals from '../components/RealTimeSignals'
// import BarraMetricasTrading from '../components/BarraMetricasTrading'
import PainelFluxoTrading from '../components/PainelFluxoTrading'
import FeedTradingAoVivo from '../components/FeedTradingAoVivo'
import RastreadorExecucaoSinal from '../components/RastreadorExecucaoSinal'
import type { BotStatus2, BotConfig } from '../types'
import { useWebSocket } from '../hooks/useWebSocket'
import { useLocalStorage } from '../hooks/useLocalStorage'

// Lazy load heavy modal component
const TradeHistory = lazy(() => import('../components/TradeHistory'))

// Query keys constants for better cache management
const QUERY_KEYS = {
  BOT_STATUS: ['parallel-bot-status'] as const,
  TRADING_STATS: ['trading-stats'] as const,
  BLACKLIST: ['parallel-bot-blacklist'] as const,
  OPEN_ORDERS: ['open-orders'] as const,
} as const

export default function TradingPage() {
  // Removendo tabs - agora é um dashboard unificado
  const [showHistoryModal, setShowHistoryModal] = useLocalStorage('tradingPageShowHistory', false)
  const [selectedSymbol] = useLocalStorage<string | null>('tradingPageSelectedSymbol', null)
  const queryClient = useQueryClient()

  // Optimized queries with consistent keys and better performance settings
  const { data: botStatusResponse, isLoading } = useQuery<{data: BotStatus2}>({
    queryKey: QUERY_KEYS.BOT_STATUS,
    queryFn: async () => {
      try {
        console.log('🔄 Fetching bot status...')
        const response = await fetch('/api/trading/parallel-bot/status')
        console.log('📡 Response status:', response.status)
        
        const result = await response.json()
        console.log('📊 Raw API result:', JSON.stringify(result, null, 2))
        
        // API always returns {success: true/false, data: {...}}
        if (result.success && result.data) {
          console.log('✅ Success response with data:', result.data)
          return { data: result.data }
        } else if (result.success) {
          console.log('✅ Success response without data field')
          return { data: result }
        } else {
          console.error('❌ API returned error:', result)
          throw new Error(result.error || 'API returned error')
        }
      } catch (error) {
        console.error('Bot status error in TradingPage:', error)
        // Return safe default in expected format
        return {
          data: {
            isRunning: false,
            demoMode: true,
            activePositions: [],
            config: {
              enabled: true,
              maxConcurrentTrades: 3,
              defaultPositionSize: 50,
              scanInterval: 30000,
              symbolsToScan: [],
              stopLossPercent: 3,
              takeProfitPercent: 5,
              trailingStopPercent: 1,
              minVolumeUSDT: 100000,
              rsiOversold: 30,
              rsiOverbought: 70,
              volumeSpikeThreshold: 2,
              minSignalStrength: 0.6,
              confirmationRequired: true,
              ma1Period: 9,
              ma2Period: 21,
              riskRewardRatio: 2,
              maxDrawdownPercent: 10,
              maxDailyLossUSDT: 100,
              maxPositionSizePercent: 10
            },
            symbolsCount: 0,
            scannedSymbols: [],
            architecture: 'parallel'
          }
        }
      }
    },
    refetchInterval: 5000, // Increased from 3s to 5s to reduce API load
    staleTime: 2000, // Consider data fresh for 2 seconds
    cacheTime: 10000, // Keep in cache for 10 seconds
    // Provide initial data in expected format
    initialData: {
      data: {
        isRunning: false,
        demoMode: true,
        activePositions: [],
        config: {
          enabled: true,
          maxConcurrentTrades: 3,
          defaultPositionSize: 50,
          scanInterval: 30000,
          symbolsToScan: [],
          stopLossPercent: 3,
          takeProfitPercent: 5,
          trailingStopPercent: 1,
          minVolumeUSDT: 100000,
          rsiOversold: 30,
          rsiOverbought: 70,
          volumeSpikeThreshold: 2,
          minSignalStrength: 0.6,
          confirmationRequired: true,
          ma1Period: 9,
          ma2Period: 21,
          riskRewardRatio: 2,
          maxDrawdownPercent: 10,
          maxDailyLossUSDT: 100,
          maxPositionSizePercent: 10
        },
        symbolsCount: 0,
        scannedSymbols: [],
        architecture: 'parallel'
      }
    }
  })

  // Extract botStatus from response for component use with comprehensive safety
  const botStatus = useMemo(() => {
    try {
      console.log('🔍 Extracting botStatus from response:', botStatusResponse)
      
      if (!botStatusResponse) {
        console.warn('⚠️ botStatusResponse is null/undefined')
        return null
      }
      
      if (!botStatusResponse.data) {
        console.warn('⚠️ botStatusResponse.data is null/undefined:', botStatusResponse)
        return null
      }
      
      console.log('✅ Extracted botStatus:', botStatusResponse.data)
      return botStatusResponse.data
    } catch (error) {
      console.error('❌ Error extracting botStatus:', error)
      return null
    }
  }, [botStatusResponse])

  // Get trading statistics - Optimized with conditional fetching
  const { data: tradingStats } = useQuery({
    queryKey: QUERY_KEYS.TRADING_STATS,
    queryFn: () => api.getTradingStats('24h'),
    refetchInterval: 15000, // Increased from 10s to 15s
    staleTime: 5000,
    cacheTime: 30000,
  })

  // Get blacklisted symbols - Optimized with longer intervals
  const { data: blacklistedSymbols } = useQuery({
    queryKey: QUERY_KEYS.BLACKLIST,
    queryFn: () => fetch('/api/trading/parallel-bot/blacklist').then(res => res.json()).then(data => data.data),
    refetchInterval: 60000, // Increased from 30s to 60s
    staleTime: 30000,
    cacheTime: 120000,
  })

  // WebSocket for real-time updates - Optimized with useCallback
  const { lastMessage } = useWebSocket('/ws')

  // Memoized WebSocket message handler to prevent unnecessary re-renders
  const handleWebSocketMessage = useCallback((message: string) => {
    try {
      const data = JSON.parse(message)
      
      // Handle different message types
      switch (data.type) {
        case 'signal':
          // New trading signal received - no action needed
          break
        case 'tradeExecuted':
          toast.success(`Trade ${data.data.side} executado para ${data.data.symbol}`)
          // Batch invalidations for better performance
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.BOT_STATUS })
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.TRADING_STATS })
          break
        case 'positionClosed':
          toast(`Posição fechada para ${data.data.symbol}`)
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.BOT_STATUS })
          break
        case 'orderUpdate':
          queryClient.invalidateQueries({ queryKey: QUERY_KEYS.OPEN_ORDERS })
          break
      }
    } catch (error) {
      console.warn('Failed to parse WebSocket message:', error)
    }
  }, [queryClient])

  useEffect(() => {
    if (lastMessage?.data) {
      handleWebSocketMessage(lastMessage.data)
    }
  }, [lastMessage, handleWebSocketMessage])

  // Optimized mutations with consistent query key usage
  const startBotMutation = useMutation({
    mutationFn: () => fetch('/api/trading/parallel-bot/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }).then(res => res.json()),
    onSuccess: () => {
      toast.success('Bot de Trading Paralelo iniciado com sucesso')
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.BOT_STATUS })
    },
    onError: (error: any) => {
      toast.error(error.message || 'Falha ao iniciar o bot')
    },
  })

  const stopBotMutation = useMutation({
    mutationFn: () => fetch('/api/trading/parallel-bot/stop', { method: 'POST' }).then(res => res.json()),
    onSuccess: () => {
      toast.success('Bot de Trading Paralelo parado')
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.BOT_STATUS })
    },
    onError: (error: any) => {
      toast.error(error.message || 'Falha ao parar o bot')
    },
  })

  const updateConfigMutation = useMutation({
    mutationFn: (config: Partial<BotConfig>) => fetch('/api/trading/parallel-bot/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config })
    }).then(res => res.json()),
    onSuccess: () => {
      toast.success('Configuração atualizada com sucesso')
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.BOT_STATUS })
    },
    onError: (error: any) => {
      toast.error(error.message || 'Falha ao atualizar configuração')
    },
  })

  const clearBlacklistMutation = useMutation({
    mutationFn: () => fetch('/api/trading/parallel-bot/blacklist/clear', { method: 'POST' }).then(res => res.json()),
    onSuccess: () => {
      toast.success('Lista negra de símbolos limpa com sucesso')
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.BLACKLIST })
    },
    onError: (error: any) => {
      toast.error(error.message || 'Falha ao limpar lista negra')
    },
  })

  // Memoized event handlers to prevent child component re-renders
  const handleStartBot = useCallback(() => {
    if (window.confirm('Tem certeza que deseja iniciar o bot de trading?')) {
      startBotMutation.mutate()
    }
  }, [startBotMutation])

  const handleStopBot = useCallback(() => {
    if (window.confirm('Tem certeza que deseja parar o bot de trading?')) {
      stopBotMutation.mutate()
    }
  }, [stopBotMutation])

  const handleUpdateConfig = useCallback((config: Partial<BotConfig>) => {
    updateConfigMutation.mutate(config)
  }, [updateConfigMutation])

  // Memoized derived data to prevent unnecessary calculations with safe defaults
  const activePositions = useMemo(() => {
    try {
      console.log('🔍 activePositions calc - botStatus:', botStatus, 'activePositions:', botStatus?.activePositions)
      
      if (!botStatus) {
        console.log('🚫 botStatus is null, returning empty array')
        return []
      }
      
      if (!Array.isArray(botStatus.activePositions)) {
        console.log('🚫 activePositions is not array:', typeof botStatus.activePositions)
        return []
      }
      
      console.log('✅ Returning activePositions:', botStatus.activePositions.length, 'items')
      return botStatus.activePositions
    } catch (error) {
      console.error('❌ Error in activePositions calculation:', error)
      return []
    }
  }, [botStatus])
  
  const isConnected = useMemo(() => {
    try {
      console.log('🔍 isConnected calc - botStatus:', botStatus)
      const connected = Boolean(botStatus && typeof botStatus === 'object')
      console.log('✅ isConnected result:', connected)
      return connected
    } catch (error) {
      console.error('❌ Error in isConnected calculation:', error)
      return false
    }
  }, [botStatus])
  
  const isDemoMode = useMemo(() => {
    try {
      console.log('🔍 isDemoMode calc - botStatus:', botStatus, 'demoMode:', botStatus?.demoMode)
      
      if (!botStatus) {
        console.log('🚫 botStatus is null, defaulting to demo mode')
        return true
      }
      
      const demoMode = Boolean(botStatus.demoMode)
      console.log('✅ isDemoMode result:', demoMode)
      return demoMode
    } catch (error) {
      console.error('❌ Error in isDemoMode calculation:', error, 'botStatus:', botStatus)
      return true // Default to demo mode for safety
    }
  }, [botStatus])
  
  // Memoized blacklist data with slice optimization
  const displayedBlacklistedSymbols = useMemo(() => 
    blacklistedSymbols?.slice(0, 6) || [], 
    [blacklistedSymbols]
  )

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      // Cancel pending requests and clear cache when component unmounts
      apiUtils.cancelAllRequests()
    }
  }, [])


  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-lg text-gray-600">Carregando...</div>
      </div>
    )
  }

  // Safety check for botStatus with detailed logging
  if (isLoading) {
    console.log('🔄 Still loading bot status...')
  } else if (!botStatusResponse) {
    console.error('❌ No botStatusResponse received')
  } else if (!botStatusResponse.data) {
    console.error('❌ botStatusResponse has no data:', botStatusResponse)
  } else {
    console.log('✅ Bot status loaded successfully:', botStatusResponse.data)
  }

  if (!isLoading && (!botStatus || typeof botStatus !== 'object')) {
    console.error('🚨 Rendering error state - botStatus:', botStatus)
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-lg text-red-600">
          Erro ao carregar status do bot. Verifique o console para detalhes.
          <br />
          <button 
            onClick={() => window.location.reload()} 
            className="mt-2 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
          >
            Recarregar Página
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col bg-gray-50">
      {/* Barra de Métricas Superior */}
      {/* <BarraMetricasTrading /> */}

      {/* Dashboard Principal */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header e Controles */}
        <div className="bg-white border-b border-gray-200 px-6 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                🎯 Central de Sinais de Trading 
              </h1>
            </div>
            <div className="flex items-center space-x-4">
              {/* Connection Status - Optimized with memoized data */}
              <div className="flex items-center space-x-2">
                <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
                <span className="text-sm text-gray-600">{isConnected ? 'Conectado' : 'Desconectado'}</span>
              </div>
              
              {/* Demo Mode Indicator - Optimized with memoized check */}
              {isDemoMode && (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">
                  Modo Demo (VST)
                </span>
              )}
              
              {/* History Button - Memoized callback */}
              <button
                onClick={useCallback(() => setShowHistoryModal(true), [setShowHistoryModal])}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                📜 Histórico
              </button>
            </div>
          </div>

          {/* Bot Controls */}
          <div className="mt-4">
            <BotControls
              botStatus={botStatus}
              onStart={handleStartBot}
              onStop={handleStopBot}
              onUpdateConfig={handleUpdateConfig}
              isStarting={startBotMutation.isLoading}
              isStopping={stopBotMutation.isLoading}
              isUpdatingConfig={updateConfigMutation.isLoading}
            />
          </div>
        </div>

        {/* Layout Principal - Design Hierárquico com Foco em Sinais */}
        <div className="flex-1 overflow-hidden p-4">
          <div className="trading-dashboard-grid">
            {/* 🎯 DESTAQUE PRINCIPAL - Sinais em Tempo Real (40% da tela) */}
            <div className="grid-area-signals">
              <div className="bg-gradient-to-r from-blue-50 to-indigo-50 p-1 rounded-lg border-2 border-blue-200 h-full">
                <RealTimeSignals />
              </div>
            </div>

            {/* 🔥 SEGUNDO DESTAQUE - Pipeline de Trading (20% da tela - linha completa) */}
            <div className="grid-area-pipeline">
              <div className="bg-gradient-to-r from-green-50 to-emerald-50 p-1 rounded-lg border-2 border-green-200 h-full">
                <PainelFluxoTrading />
              </div>
            </div>
            
            {/* 📊 TERCEIRO DESTAQUE - Posições Abertas (20% da tela - linha completa) */}
            <div className="grid-area-positions">
              <div className="bg-gradient-to-r from-orange-50 to-amber-50 p-1 rounded-lg border-2 border-orange-200 h-full">
                <PositionsTable positions={activePositions} />
              </div>
            </div>

            {/* 📈 COMPONENTES SECUNDÁRIOS - Organizados Embaixo (20% da tela) */}
            
            {/* Estatísticas de Trading */}
            <div className="grid-area-stats">
              <TradingStats stats={tradingStats} />
            </div>

            {/* Rastreador de Execução */}
            <div className="grid-area-tracker">
              <RastreadorExecucaoSinal 
                symbolFilter={selectedSymbol || undefined}
                limit={3}
              />
            </div>

            {/* Feed de Atividades */}
            <div className="grid-area-feed">
              <FeedTradingAoVivo />
            </div>
          </div>

          {/* Blacklisted Symbols Warning - Seção separada abaixo do grid */}
          {blacklistedSymbols && blacklistedSymbols.length > 0 && (
            <div className="mt-4 bg-yellow-50 border-2 border-yellow-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="font-medium text-yellow-900">Símbolos na Lista Negra</h3>
                  <p className="text-sm text-yellow-700">
                    {blacklistedSymbols.length} símbolo(s) temporariamente bloqueados devido a erros
                  </p>
                </div>
                <button
                  onClick={() => clearBlacklistMutation.mutate()}
                  disabled={clearBlacklistMutation.isLoading}
                  className="px-3 py-1 bg-yellow-600 text-white text-sm rounded hover:bg-yellow-700 disabled:opacity-50"
                >
                  {clearBlacklistMutation.isLoading ? 'Limpando...' : 'Limpar Todos'}
                </button>
              </div>
              <div className="grid grid-cols-6 gap-2">
                {displayedBlacklistedSymbols.map((item: any) => (
                  <div key={item.symbol} className="flex items-center justify-between bg-white p-2 rounded border border-yellow-300">
                    <span className="font-medium text-gray-900">{item.symbol}</span>
                    <div className="text-xs text-gray-600">
                      <div>Falhas: {item.count}</div>
                      <div>Até: {new Date(item.backoffUntil).toLocaleTimeString('pt-BR')}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modal de Histórico - Lazy loaded for better performance */}
      {showHistoryModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900">Histórico de Trades</h2>
              <button
                onClick={useCallback(() => setShowHistoryModal(false), [setShowHistoryModal])}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6 overflow-y-auto max-h-[calc(90vh-80px)]">
              <Suspense fallback={
                <div className="flex items-center justify-center h-64">
                  <div className="text-lg text-gray-600">Carregando histórico...</div>
                </div>
              }>
                <TradeHistory />
              </Suspense>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}