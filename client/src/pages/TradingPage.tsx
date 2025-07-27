import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { toast } from 'react-hot-toast'
import { api } from '../services/api'
import BotControls from '../components/BotControls'
import PositionsTable from '../components/PositionsTable'
import TradingStats from '../components/TradingStats'
import TradeHistory from '../components/TradeHistory'
import RealTimeSignals from '../components/RealTimeSignals'
import type { BotStatus, BotConfig } from '../types'
import { useWebSocket } from '../hooks/useWebSocket'

export default function TradingPage() {
  const [activeTab, setActiveTab] = useState<'overview' | 'positions' | 'history' | 'signals' | 'logs'>('overview')
  const [logsLevel, setLogsLevel] = useState<'all' | 'error'>('all')
  const queryClient = useQueryClient()

  // Get bot status
  const { data: botStatus, isLoading } = useQuery<BotStatus>(
    'bot-status',
    api.getBotStatus,
    {
      refetchInterval: 3000,
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

  // Get bot logs
  const { data: botLogs, isLoading: logsLoading } = useQuery(
    ['bot-logs', logsLevel],
    async () => {
      const response = await api.getBotLogs({ limit: 50, level: logsLevel })
      return response
    },
    {
      refetchInterval: 10000, // Update every 10 seconds
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
          toast.success(`Trade executed: ${data.data.side} ${data.data.symbol}`)
          queryClient.invalidateQueries('bot-status')
          queryClient.invalidateQueries('trading-stats')
          break
        case 'positionClosed':
          toast(`Position closed: ${data.data.symbol}`)
          queryClient.invalidateQueries('bot-status')
          break
        case 'orderUpdate':
          queryClient.invalidateQueries('open-orders')
          break
      }
    }
  }, [lastMessage, queryClient])

  // Start bot mutation
  const startBotMutation = useMutation(api.startBot, {
    onSuccess: () => {
      toast.success('Trading bot started successfully')
      queryClient.invalidateQueries('bot-status')
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })

  // Stop bot mutation
  const stopBotMutation = useMutation(api.stopBot, {
    onSuccess: () => {
      toast.success('Trading bot stopped successfully')
      queryClient.invalidateQueries('bot-status')
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })

  // Update config mutation
  const updateConfigMutation = useMutation(api.updateBotConfig, {
    onSuccess: () => {
      toast.success('Bot configuration updated')
      queryClient.invalidateQueries('bot-status')
    },
    onError: (error: Error) => {
      toast.error(error.message)
    },
  })

  const handleStartBot = () => {
    if (window.confirm('Are you sure you want to start the trading bot?')) {
      startBotMutation.mutate()
    }
  }

  const handleStopBot = () => {
    if (window.confirm('Are you sure you want to stop the trading bot?')) {
      stopBotMutation.mutate()
    }
  }

  const handleUpdateConfig = (config: Partial<BotConfig>) => {
    updateConfigMutation.mutate(config)
  }

  // Format log timestamp
  const formatLogTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString('pt-BR')
  }

  // Get log level color
  const getLogLevelColor = (level: string) => {
    switch (level) {
      case 'error':
        return 'text-red-600'
      case 'warn':
        return 'text-yellow-600'
      case 'info':
        return 'text-blue-600'
      case 'debug':
        return 'text-gray-600'
      default:
        return 'text-gray-900'
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-lg text-gray-600">Loading trading bot...</div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Trading Bot</h1>
        <div className="flex items-center space-x-4">
          {/* Connection Status */}
          <div className="flex items-center space-x-2">
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <span className="text-sm text-gray-600">Connected to BingX</span>
          </div>
          
          {/* Demo Mode Indicator */}
          {botStatus?.demoMode && (
            <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">
              Demo Trading (VST)
            </span>
          )}
        </div>
      </div>

      {/* Bot Controls */}
      <BotControls
        botStatus={botStatus}
        onStart={handleStartBot}
        onStop={handleStopBot}
        onUpdateConfig={handleUpdateConfig}
        isStarting={startBotMutation.isLoading}
        isStopping={stopBotMutation.isLoading}
        isUpdatingConfig={updateConfigMutation.isLoading}
      />

      {/* Trading Overview Cards */}
      {tradingStats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="card p-6">
            <h3 className="text-sm font-medium text-gray-500">Total Trades (24h)</h3>
            <p className="text-2xl font-bold text-gray-900">{tradingStats.totalTrades}</p>
          </div>
          <div className="card p-6">
            <h3 className="text-sm font-medium text-gray-500">Win Rate</h3>
            <p className="text-2xl font-bold text-green-600">{tradingStats.winRate}%</p>
          </div>
          <div className="card p-6">
            <h3 className="text-sm font-medium text-gray-500">Total P&L (24h)</h3>
            <p className={`text-2xl font-bold ${
              parseFloat(tradingStats.totalPnl) >= 0 ? 'text-green-600' : 'text-red-600'
            }`}>
              {parseFloat(tradingStats.totalPnl) >= 0 ? '+' : ''}
              {tradingStats.totalPnl} {botStatus?.demoMode ? 'VST' : 'USDT'}
            </p>
          </div>
          <div className="card p-6">
            <h3 className="text-sm font-medium text-gray-500">Active Positions</h3>
            <p className="text-2xl font-bold text-gray-900">
              {botStatus?.activePositions?.length || 0}
            </p>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-8">
          {[
            { id: 'overview', name: 'Overview', count: botStatus?.activePositions?.length },
            { id: 'positions', name: 'Positions', count: botStatus?.activePositions?.length },
            { id: 'history', name: 'Trade History' },
            { id: 'signals', name: 'Live Signals' },
            { id: 'logs', name: 'Bot Logs' }
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`py-2 px-1 border-b-2 font-medium text-sm whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.name}
              {tab.count !== undefined && tab.count > 0 && (
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      <div className="mt-6">
        {activeTab === 'overview' && (
          <div className="space-y-6">
            <TradingStats stats={tradingStats} />
            {botStatus?.activePositions && botStatus.activePositions.length > 0 && (
              <PositionsTable positions={botStatus.activePositions} />
            )}
          </div>
        )}

        {activeTab === 'positions' && (
          <PositionsTable positions={botStatus?.activePositions || []} />
        )}

        {activeTab === 'history' && (
          <TradeHistory />
        )}

        {activeTab === 'signals' && (
          <RealTimeSignals />
        )}

        {activeTab === 'logs' && (
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Logs do Bot</h2>
              <select
                value={logsLevel}
                onChange={(e) => setLogsLevel(e.target.value as 'all' | 'error')}
                className="text-sm border border-gray-300 rounded-md px-2 py-1"
              >
                <option value="all">Todos os logs</option>
                <option value="error">Apenas erros</option>
              </select>
            </div>
            
            <div className="bg-gray-900 rounded-md p-4 h-96 overflow-y-auto">
              {logsLoading ? (
                <div className="text-gray-400 text-sm">Carregando logs...</div>
              ) : botLogs && botLogs.length > 0 ? (
                <div className="space-y-1">
                  {botLogs.map((log, index) => (
                    <div key={index} className="text-xs font-mono">
                      <span className="text-gray-500">[{formatLogTime(log.timestamp)}]</span>
                      <span className={`ml-2 ${getLogLevelColor(log.level)} uppercase`}>
                        {log.level}
                      </span>
                      <span className="ml-2 text-gray-300">{log.message}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-gray-400 text-sm">Nenhum log disponível</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}