import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { toast } from 'react-hot-toast'
import { api } from '../services/api'
import BotControls from '../components/BotControls'
import PositionsTable from '../components/PositionsTable'
import TradingStats from '../components/TradingStats'
import TradeHistory from '../components/TradeHistory'
import RealTimeSignals from '../components/RealTimeSignals'
import TradingFlowMonitor from '../components/TradingFlowMonitor'
import type { BotStatus2, BotConfig } from '../types'
import { useWebSocket } from '../hooks/useWebSocket'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { useTranslation } from '../hooks/useTranslation'

export default function TradingPage() {
  // Use localStorage for persistent state
  const [activeTab, setActiveTab] = useLocalStorage<'overview' | 'positions' | 'history' | 'signals' | 'logs' | 'performance'>('tradingPageActiveTab', 'overview')
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
  console.log('Bot Status Debug:', { botStatus, isLoading })
  // Get parallel bot metrics
  const { data: parallelMetrics } = useQuery(
    'parallel-bot-metrics',
    () => fetch('/api/trading/parallel-bot/metrics').then(res => res.json()).then(data => data.data),
    { 
      enabled: botStatus?.isRunning,
      refetchInterval: 5000 
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Parallel Trading Bot</h1>
          <p className="text-sm text-gray-600">High-performance parallel signal processing and trade execution</p>
        </div>
        <div className="flex items-center space-x-4">
          {/* Architecture Indicator */}
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800">
            Parallel Architecture
          </span>
          
          {/* Rate Limit Status */}
          <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
            rateLimitStatus?.remainingRequests > 50 ? 'bg-green-100 text-green-800' :
            rateLimitStatus?.remainingRequests > 20 ? 'bg-yellow-100 text-yellow-800' :
            'bg-red-100 text-red-800'
          }`}>
            {rateLimitStatus 
              ? `${rateLimitStatus.remainingRequests}/${rateLimitStatus.maxRequests} Available`
              : '100 req/10s Rate Limited'
            }
          </span>
          
          {/* Connection Status */}
          <div className="flex items-center space-x-2">
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <span className="text-sm text-gray-600">{t('trading.connectionStatus')}</span>
          </div>
          
          {/* Demo Mode Indicator */}
          {botStatus?.demoMode && (
            <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">
              {t('dashboard.demoMode')} (VST)
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
     
      {/* Navigation Tabs */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-8">
          {[
            { id: 'overview', name: 'Overview', count: botStatus?.activePositions?.length },
            // { id: 'performance', name: 'Performance', count: performanceData?.alerts?.length },
            { id: 'signals', name: 'Signals', count: activityEvents?.filter((e: any) => e.type === 'signal_generated')?.length },
            { id: 'positions', name: 'Positions', count: botStatus?.activePositions?.length },
            { id: 'history', name: 'History' },
            { id: 'logs', name: 'Activity' }
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
            
            {/* Trading Flow Monitor */}
            <TradingFlowMonitor 
              activityEvents={activityEvents}
              parallelMetrics={parallelMetrics}
              isParallelBot={true}
            />
            
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

        {activeTab === 'performance' && (
          <div className="space-y-6">
            {/* Rate Limit Status */}
            {rateLimitStatus && (
              <div className="card p-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">API Rate Limit Status</h3>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <div>
                    <h4 className="text-sm font-medium text-gray-500">Current Usage</h4>
                    <p className="text-xl font-bold text-blue-600">
                      {rateLimitStatus.currentRequests}/{rateLimitStatus.maxRequests}
                    </p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-gray-500">Remaining</h4>
                    <p className={`text-xl font-bold ${
                      rateLimitStatus.remainingRequests > 50 ? 'text-green-600' :
                      rateLimitStatus.remainingRequests > 20 ? 'text-yellow-600' : 'text-red-600'
                    }`}>
                      {rateLimitStatus.remainingRequests}
                    </p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-gray-500">Window</h4>
                    <p className="text-xl font-bold text-gray-900">
                      {(rateLimitStatus.windowMs / 1000).toFixed(0)}s
                    </p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-gray-500">Oldest Request</h4>
                    <p className="text-xl font-bold text-gray-900">
                      {rateLimitStatus.oldestRequestAge > 0 
                        ? `${(rateLimitStatus.oldestRequestAge / 1000).toFixed(1)}s ago`
                        : 'None'
                      }
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Performance Summary */}
            {performanceData?.summary && (
              <div className="card p-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Performance Summary (30 min)</h3>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                  <div>
                    <h4 className="text-sm font-medium text-gray-500">Avg Throughput</h4>
                    <p className="text-xl font-bold text-blue-600">
                      {performanceData.summary.averages.signalsPerMinute.toFixed(1)} signals/min
                    </p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-gray-500">Avg Latency</h4>
                    <p className="text-xl font-bold text-gray-900">
                      {(performanceData.summary.averages.avgLatency / 1000).toFixed(1)}s
                    </p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-gray-500">Worker Utilization</h4>
                    <p className="text-xl font-bold text-indigo-600">
                      {performanceData.summary.averages.workerUtilization.toFixed(1)}%
                    </p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-gray-500">Cache Hit Rate</h4>
                    <p className="text-xl font-bold text-green-600">
                      {performanceData.summary.averages.cacheHitRate.toFixed(1)}%
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Performance Trends */}
            {performanceData?.trends && (
              <div className="card p-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Performance Trends</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <h4 className="text-sm font-medium text-gray-500">Throughput Trend</h4>
                    <p className={`text-lg font-bold ${
                      performanceData.trends.trends.throughput.direction === 'increasing' ? 'text-green-600' :
                      performanceData.trends.trends.throughput.direction === 'decreasing' ? 'text-red-600' : 'text-gray-600'
                    }`}>
                      {performanceData.trends.trends.throughput.direction}
                    </p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-gray-500">Latency Trend</h4>
                    <p className={`text-lg font-bold ${
                      performanceData.trends.trends.latency.direction === 'decreasing' ? 'text-green-600' :
                      performanceData.trends.trends.latency.direction === 'increasing' ? 'text-red-600' : 'text-gray-600'
                    }`}>
                      {performanceData.trends.trends.latency.direction}
                    </p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-gray-500">Utilization Trend</h4>
                    <p className={`text-lg font-bold ${
                      performanceData.trends.trends.utilization.direction === 'increasing' ? 'text-blue-600' :
                      performanceData.trends.trends.utilization.direction === 'decreasing' ? 'text-orange-600' : 'text-gray-600'
                    }`}>
                      {performanceData.trends.trends.utilization.direction}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Bottleneck Analysis */}
            {performanceData?.bottlenecks && (
              <div className="card p-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Bottleneck Analysis</h3>
                <div className={`p-4 rounded-lg ${
                  performanceData.bottlenecks.overallHealth === 'healthy' ? 'bg-green-50 border border-green-200' :
                  performanceData.bottlenecks.overallHealth === 'warning' ? 'bg-yellow-50 border border-yellow-200' :
                  performanceData.bottlenecks.overallHealth === 'degraded' ? 'bg-orange-50 border border-orange-200' :
                  'bg-red-50 border border-red-200'
                }`}>
                  <h4 className="font-medium">Overall Health: {performanceData.bottlenecks.overallHealth}</h4>
                  {performanceData.bottlenecks.bottlenecks.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {performanceData.bottlenecks.bottlenecks.map((bottleneck: any, index: number) => (
                        <div key={index} className="text-sm">
                          <span className="font-medium">{bottleneck.component}:</span> {bottleneck.issue}
                          <div className="text-gray-600 ml-2">→ {bottleneck.recommendation}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-green-600">No bottlenecks detected</p>
                  )}
                </div>
              </div>
            )}

            {/* Performance Alerts */}
            {performanceData?.alerts && performanceData.alerts.length > 0 && (
              <div className="card p-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Performance Alerts</h3>
                <div className="space-y-3">
                  {performanceData.alerts.map((alert: any) => (
                    <div key={alert.id} className={`p-3 rounded-lg border ${
                      alert.severity === 'critical' ? 'bg-red-50 border-red-200' : 'bg-yellow-50 border-yellow-200'
                    }`}>
                      <div className="flex justify-between items-start">
                        <div>
                          <h4 className="font-medium">{alert.type}</h4>
                          <p className="text-sm text-gray-600">{alert.message}</p>
                        </div>
                        <span className={`px-2 py-1 text-xs rounded ${
                          alert.severity === 'critical' ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'
                        }`}>
                          {alert.severity}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'signals' && (
          <RealTimeSignals />
        )}

        {activeTab === 'logs' && (
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Parallel Bot Activity</h2>
              <div className="flex items-center space-x-4">
                <span className="text-sm text-gray-500">
                  {activityEvents?.length || 0} events
                </span>
                {activityEvents && activityEvents.length > 0 && (
                  <button
                    onClick={() => {
                      // Clear activity events via API
                      fetch('/api/trading/parallel-bot/clear-queue', { method: 'POST' })
                        .then(() => queryClient.invalidateQueries('parallel-bot-activity'))
                    }}
                    className="text-sm text-red-600 hover:text-red-800 px-2 py-1 rounded border border-red-300 hover:bg-red-50"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            
            <div className="space-y-2 h-96 overflow-y-auto">
              {activityEvents && activityEvents.length > 0 ? (
                activityEvents.map((event: any, index: number) => {
                  const isRecent = event.timestamp && (Date.now() - event.timestamp) < 30000; // 30 seconds
                  const levelColors: Record<string, string> = {
                    info: 'text-blue-600',
                    success: 'text-green-600', 
                    warning: 'text-yellow-600',
                    error: 'text-red-600'
                  };
                  const levelBg: Record<string, string> = {
                    info: 'bg-blue-50 border-blue-200',
                    success: 'bg-green-50 border-green-200',
                    warning: 'bg-yellow-50 border-yellow-200', 
                    error: 'bg-red-50 border-red-200'
                  };
                  
                  return (
                    <div 
                      key={index} 
                      className={`p-3 rounded-lg border ${isRecent ? 'ring-2 ring-blue-200' : ''} ${levelBg[event.level] || 'bg-gray-50 border-gray-200'}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <span className={`text-xs font-medium uppercase ${levelColors[event.level] || 'text-gray-600'}`}>
                            {event.level}
                          </span>
                          <span className="text-xs text-gray-500 font-mono">
                            {event.type.replace(/_/g, ' ')}
                          </span>
                          {event.symbol && (
                            <span className="text-xs font-medium text-gray-700 bg-gray-100 px-2 py-0.5 rounded">
                              {event.symbol}
                            </span>
                          )}
                          {isRecent && (
                            <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full">
                              NEW
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-gray-500">
                          {new Date(event.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="mt-1 text-sm text-gray-700">
                        {event.message}
                      </div>
                      {event.metadata && (
                        <div className="mt-1 text-xs text-gray-500 font-mono">
                          {Object.entries(event.metadata).map(([key, value]) => (
                            <span key={key} className="mr-3">
                              {key}: {String(value)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })
              ) : (
                <div className="flex items-center justify-center h-64 text-gray-500">
                  <div className="text-center">
                    <div className="text-2xl mb-2">📊</div>
                    <div>No activity events yet</div>
                    <div className="text-sm mt-1">Activity will appear here when the parallel bot is running</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}