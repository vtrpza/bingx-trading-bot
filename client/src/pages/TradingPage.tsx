import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { toast } from 'react-hot-toast'
import { api } from '../services/api'
import BotControls from '../components/BotControls'
import PositionsTable from '../components/PositionsTable'
import TradingStats from '../components/TradingStats'
import TradeHistory from '../components/TradeHistory'
import RealTimeSignals from '../components/RealTimeSignals'
import BarraMetricasTrading from '../components/BarraMetricasTrading'
import PainelFluxoTrading from '../components/PainelFluxoTrading'
import FeedTradingAoVivo from '../components/FeedTradingAoVivo'
import RastreadorExecucaoSinal from '../components/RastreadorExecucaoSinal'
import type { BotStatus2, BotConfig } from '../types'
import { useWebSocket } from '../hooks/useWebSocket'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { useTranslation } from '../hooks/useTranslation'

export default function TradingPage() {
  // Removendo tabs - agora é um dashboard unificado
  const [showHistoryModal, setShowHistoryModal] = useLocalStorage('tradingPageShowHistory', false)
  const [selectedSymbol, setSelectedSymbol] = useLocalStorage<string | null>('tradingPageSelectedSymbol', null)
  const queryClient = useQueryClient()
  const { t } = useTranslation()

  // Get parallel bot status
  const { data: botStatus, isLoading } = useQuery<BotStatus2>(
    'parallel-bot-status',
    () => fetch('/api/trading/parallel-bot/status').then(res => res.json()).then(data => data.data),
    {
      refetchInterval: 3000,
    }
  )

  // Get parallel bot performance data
  const { data: performanceData } = useQuery(
    'parallel-bot-performance',
    () => fetch('/api/trading/parallel-bot/performance?minutes=30').then(res => res.json()).then(data => data.data),
    { 
      enabled: botStatus?.isRunning,
      refetchInterval: 10000 
    }
  )
  // Get parallel bot activity events
  const { data: activityEvents } = useQuery(
    'parallel-bot-activity',
    () => fetch('/api/trading/parallel-bot/activity?limit=50').then(res => res.json()).then(data => data.data),
    { 
      refetchInterval: 5000 
    }
  )

  // Get rate limit status
  const { data: rateLimitStatus } = useQuery(
    'parallel-bot-rate-limit',
    () => fetch('/api/trading/parallel-bot/rate-limit').then(res => res.json()).then(data => data.data),
    { 
      refetchInterval: 2000 
    }
  )

  // Get trading statistics
  const { data: tradingStats } = useQuery(
    'trading-stats',
    () => api.getTradingStats('24h'),
    {
      refetchInterval: 10000,
    }
  )

  // Get blacklisted symbols
  const { data: blacklistedSymbols } = useQuery(
    'parallel-bot-blacklist',
    () => fetch('/api/trading/parallel-bot/blacklist').then(res => res.json()).then(data => data.data),
    { 
      refetchInterval: 30000 // Check every 30 seconds
    }
  )

  // WebSocket for real-time updates
  const { lastMessage } = useWebSocket('/ws')

  useEffect(() => {
    if (lastMessage) {
      const data = JSON.parse(lastMessage.data)
      
      // Handle different message types
      switch (data.type) {
        case 'signal':
          // New trading signal received
          break
        case 'tradeExecuted':
          toast.success(t('trading.notifications.tradeExecuted').replace('{side}', data.data.side).replace('{symbol}', data.data.symbol))
          queryClient.invalidateQueries('parallel-bot-status')
          queryClient.invalidateQueries('trading-stats')
          break
        case 'positionClosed':
          toast(t('trading.notifications.positionClosed').replace('{symbol}', data.data.symbol))
          queryClient.invalidateQueries('parallel-bot-status')
          break
        case 'orderUpdate':
          queryClient.invalidateQueries('open-orders')
          break
      }
    }
  }, [lastMessage, queryClient])

  // Start parallel bot mutation
  const startBotMutation = useMutation(
    () => fetch('/api/trading/parallel-bot/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }).then(res => res.json()),
    {
      onSuccess: () => {
        toast.success('Parallel Trading Bot started successfully')
        queryClient.invalidateQueries('parallel-bot-status')
      },
      onError: (error: any) => {
        toast.error(error.message || 'Failed to start bot')
      },
    }
  )

  // Stop parallel bot mutation  
  const stopBotMutation = useMutation(
    () => fetch('/api/trading/parallel-bot/stop', { method: 'POST' }).then(res => res.json()),
    {
      onSuccess: () => {
        toast.success('Parallel Trading Bot stopped')
        queryClient.invalidateQueries('parallel-bot-status')
      },
      onError: (error: any) => {
        toast.error(error.message || 'Failed to stop bot')
      },
    }
  )

  // Update config mutation
  const updateConfigMutation = useMutation(
    (config: Partial<BotConfig>) => fetch('/api/trading/parallel-bot/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config })
    }).then(res => res.json()),
    {
      onSuccess: () => {
        toast.success('Configuration updated successfully')
        queryClient.invalidateQueries('parallel-bot-status')
      },
      onError: (error: any) => {
        toast.error(error.message || 'Failed to update config')
      },
    }
  )

  // Clear blacklist mutation
  const clearBlacklistMutation = useMutation(
    () => fetch('/api/trading/parallel-bot/blacklist/clear', { method: 'POST' }).then(res => res.json()),
    {
      onSuccess: () => {
        toast.success('Symbol blacklist cleared successfully')
        queryClient.invalidateQueries('parallel-bot-blacklist')
      },
      onError: (error: any) => {
        toast.error(error.message || 'Failed to clear blacklist')
      },
    }
  )

  // Force scan mutation (commented out for now as not used)
  // const forceScanMutation = useMutation(
  //   (symbols?: string[]) => fetch('/api/trading/parallel-bot/scan', {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify({ symbols })
  //   }).then(res => res.json()),
  //   {
  //     onSuccess: () => {
  //       toast.success('Signal scan initiated')
  //     },
  //     onError: (error: any) => {
  //       toast.error(error.message || 'Failed to initiate scan')
  //     },
  //   }
  // )

  const handleStartBot = () => {
    if (window.confirm(t('trading.confirmations.startBot'))) {
      startBotMutation.mutate()
    }
  }

  const handleStopBot = () => {
    if (window.confirm(t('trading.confirmations.stopBot'))) {
      stopBotMutation.mutate()
    }
  }

  const handleUpdateConfig = (config: Partial<BotConfig>) => {
    updateConfigMutation.mutate(config)
  }


  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-lg text-gray-600">{t('common.loading')}</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col bg-gray-50">
      {/* Barra de Métricas Superior */}
      <BarraMetricasTrading />

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
              {/* Connection Status */}
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
                <span className="text-sm text-gray-600">Conectado</span>
              </div>
              
              {/* Demo Mode Indicator */}
              {botStatus?.demoMode && (
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">
                  Modo Demo (VST)
                </span>
              )}
              
              {/* History Button */}
              <button
                onClick={() => setShowHistoryModal(true)}
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
                <PositionsTable positions={botStatus?.activePositions || []} />
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
                {blacklistedSymbols.slice(0, 6).map((item: any) => (
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

      {/* Modal de Histórico */}
      {showHistoryModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900">Histórico de Trades</h2>
              <button
                onClick={() => setShowHistoryModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-6 overflow-y-auto max-h-[calc(90vh-80px)]">
              <TradeHistory />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}