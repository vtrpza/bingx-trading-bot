import { useEffect } from 'react'
import { useQuery } from 'react-query'
import { api } from '../services/api'
import { useWebSocket } from '../hooks/useWebSocket'
import { useLocalStorage } from '../hooks/useLocalStorage'
import { useTranslation } from '../hooks/useTranslation'
import type { TradingSignal } from '../types'

export default function RealTimeSignals() {
  const [signals, setSignals] = useLocalStorage<TradingSignal[]>('realTimeSignals', [])
  const [selectedSymbol, setSelectedSymbol] = useLocalStorage('realTimeSignalsSelectedSymbol', 'BTC-USDT')
  const { t } = useTranslation()
  
  // Calculate signal statistics
  const signalStats = {
    total: signals.length,
    buy: signals.filter(s => s.action === 'BUY').length,
    sell: signals.filter(s => s.action === 'SELL').length,
    hold: signals.filter(s => s.action === 'HOLD').length,
    avgStrength: signals.length > 0 
      ? (signals.reduce((sum, s) => sum + (s.strength || 0), 0) / signals.length).toFixed(1)
      : '0',
    recentStrong: signals.filter(s => (s.strength || 0) >= 70).length
  }

  const { lastMessage, connectionStatus } = useWebSocket('/ws')
  
  // Debug WebSocket connection
  useEffect(() => {
    console.log('🔌 WebSocket connection status:', connectionStatus)
  }, [connectionStatus])

  // Get parallel bot status (only parallel mode now)
  const { data: botStatus } = useQuery(
    'parallel-bot-status', 
    () => fetch('/api/trading/parallel-bot/status').then(res => res.json()).then(data => data.data)
  )

  // Get parallel bot metrics (commented out for now as not used in display)
  // const { data: parallelMetrics } = useQuery(
  //   'parallel-bot-metrics',
  //   () => fetch('/api/trading/parallel-bot/metrics').then(res => res.json()).then(data => data.data),
  //   { 
  //     enabled: botStatus?.isRunning,
  //     refetchInterval: 5000 
  //   }
  // )

  // Get parallel bot activity events for signal display (commented out for now as not used in display)
  // const { data: parallelActivity } = useQuery(
  //   'parallel-bot-activity',
  //   () => fetch('/api/trading/parallel-bot/activity?limit=20&type=signal_generated').then(res => res.json()).then(data => data.data),
  //   { 
  //     refetchInterval: 3000 
  //   }
  // )
  
  // Get market overview for fallback
  const { data: marketOverview } = useQuery('market-overview', api.getMarketOverview)
  
  // Use symbols from bot or fallback to market overview
  const availableSymbols = botStatus?.scannedSymbols || marketOverview?.topVolume?.map((item: any) => item.symbol) || []
  const watchedSymbols = availableSymbols

  // Function to format the symbol for the API call
  const formatSymbolForApi = (symbol: string) => {
    if (symbol && !symbol.endsWith('-USDT') && !symbol.endsWith('-USDC')) {
      return `${symbol}-USDT`;
    }
    return symbol;
  };

  const apiReadySymbol = formatSymbolForApi(selectedSymbol);

  // Get signal for selected symbol
  const { data: currentSignal, isLoading: signalLoading, error: signalError } = useQuery(
    ['signal', apiReadySymbol],
    () => api.getSignal(apiReadySymbol),
    {
      refetchInterval: 10000, // Refresh every 10 seconds
      enabled: !!apiReadySymbol, // Only fetch if symbol is selected
      retry: 2, // Retry failed requests
    }
  )
  console.log(signalError)
  // Clean old signals (older than 1 hour) on component mount
  useEffect(() => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    setSignals(prev => prev.filter(signal => 
      signal.timestamp && new Date(signal.timestamp) > oneHourAgo
    ))
  }, [])

  useEffect(() => {
    if (lastMessage) {
      console.log('🔄 WebSocket message received:', lastMessage.data)
      try {
        const data = JSON.parse(lastMessage.data)
        console.log('📊 Parsed WebSocket data:', data)
        
        if (data.type === 'signal') {
          console.log('📈 Signal data received:', data.data)
          // Add new signal to the list and keep only 50 latest signals
          setSignals(prev => {
            const newSignals = [data.data, ...prev]
            console.log('💾 Updated signals array:', newSignals.length, 'signals')
            // Keep only 50 most recent signals
            return newSignals.slice(0, 50)
          })
        } else {
          console.log('ℹ️ Non-signal WebSocket message type:', data.type)
        }
      } catch (error) {
        console.error('❌ Error parsing WebSocket message:', error)
      }
    }
  }, [lastMessage, setSignals])

  const getSignalStrengthColor = (strength: number) => {
    if (strength >= 80) return 'text-green-600'
    if (strength >= 60) return 'text-yellow-600'
    return 'text-red-600'
  }

  const getActionBadge = (action: string) => {
    const config = {
      'BUY': { bg: 'bg-green-100', text: 'text-green-800' },
      'SELL': { bg: 'bg-red-100', text: 'text-red-800' },
      'HOLD': { bg: 'bg-gray-100', text: 'text-gray-800' }
    }

    const style = config[action as keyof typeof config] || config['HOLD']
    
    return (
      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${style.bg} ${style.text}`}>
        {action}
      </span>
    )
  }

  return (
    <div className="space-y-6">
      {/* Signal Statistics */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
        <div className="card p-4 text-center">
          <div className="text-2xl font-bold text-gray-900">{signalStats.total}</div>
          <div className="text-sm text-gray-500">Total Sinais</div>
        </div>
        <div className="card p-4 text-center">
          <div className="text-2xl font-bold text-green-600">{signalStats.buy}</div>
          <div className="text-sm text-gray-500">BUY</div>
        </div>
        <div className="card p-4 text-center">
          <div className="text-2xl font-bold text-red-600">{signalStats.sell}</div>
          <div className="text-sm text-gray-500">SELL</div>
        </div>
        <div className="card p-4 text-center">
          <div className="text-2xl font-bold text-gray-600">{signalStats.hold}</div>
          <div className="text-sm text-gray-500">HOLD</div>
        </div>
        <div className="card p-4 text-center">
          <div className="text-2xl font-bold text-blue-600">{signalStats.avgStrength}%</div>
          <div className="text-sm text-gray-500">Força Média</div>
        </div>
        <div className="card p-4 text-center">
          <div className="text-2xl font-bold text-purple-600">{signalStats.recentStrong}</div>
          <div className="text-sm text-gray-500">Sinais Fortes</div>
        </div>
      </div>

      {/* Symbol Selection */}
      <div className="card p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-medium text-gray-900">{t('trading.signals.title')}</h3>
          <div className="flex items-center space-x-4">
            <div className={`flex items-center space-x-2 ${
              connectionStatus === 'connected' ? 'text-green-600' : 
              connectionStatus === 'connecting' ? 'text-yellow-600' : 'text-red-600'
            }`}>
              <div className={`w-2 h-2 rounded-full ${
                connectionStatus === 'connected' ? 'bg-green-500' : 
                connectionStatus === 'connecting' ? 'bg-yellow-500' : 'bg-red-500'
              }`}></div>
              <span className="text-sm font-medium">{connectionStatus}</span>
            </div>
            <div className="text-sm text-gray-500">
              {signals.length} signals
            </div>
          </div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="label">{t('trading.signals.selectedSymbol')}</label>
            <select
              value={selectedSymbol}
              onChange={(e) => setSelectedSymbol(e.target.value)}
              className="input"
            >
              {availableSymbols.length === 0 ? (
                <option value="">Loading symbols...</option>
              ) : (
                availableSymbols.map((symbol: string) => (
                  <option key={symbol} value={symbol}>
                    {symbol} {botStatus?.scannedSymbols ? '(Parallel Bot)' : '(High Volume)'}
                  </option>
                ))
              )}
            </select>
          </div>
          
          <div>
            <label className="label">{t('trading.signals.watchedSymbols')}</label>
            <div className="flex flex-wrap gap-2">
              {watchedSymbols.map((symbol: string) => (
                <button
                  key={symbol}
                  onClick={() => setSelectedSymbol(symbol)}
                  className={`px-3 py-1 text-sm rounded-full border ${
                    selectedSymbol === symbol
                      ? 'bg-primary-100 border-primary-300 text-primary-700'
                      : 'bg-gray-100 border-gray-300 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {symbol}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Current Signal Analysis */}
      {signalLoading ? (
        <div className="card p-6">
          <div className="flex items-center justify-center h-32">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-2"></div>
              <div className="text-gray-600">Loading signal for {selectedSymbol}...</div>
            </div>
          </div>
        </div>
      ) : signalError ? (
        <div className="card p-6">
          <div className="flex items-center justify-center h-32">
            <div className="text-center">
              <div className="text-red-600 text-lg mb-2">⚠️</div>
              <div className="text-gray-600">Failed to load signal for {selectedSymbol}</div>
              <div className="text-sm text-gray-500 mt-1">
                {signalError instanceof Error ? signalError.message : 'Unknown error'}
              </div>
            </div>
          </div>
        </div>
      ) : currentSignal ? (
        <div className="card p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-medium text-gray-900">
              Current Signal: {selectedSymbol}
            </h3>
            <div className="flex items-center space-x-2">
              {getActionBadge(currentSignal.action)}
              <span className={`font-bold ${getSignalStrengthColor(currentSignal.strength)}`}>
                {currentSignal.strength}%
              </span>
            </div>
          </div>

          {currentSignal.indicators ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {/* Price Info */}
              <div>
                <h4 className="text-sm font-medium text-gray-500 mb-2">Price Info</h4>
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Current:</span>
                    <span className="text-sm font-medium">
                      {currentSignal.indicators.price && currentSignal.indicators.price !== null ? 
                        `$${Number(currentSignal.indicators.price).toFixed(4)}` : 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">MA1 (9):</span>
                    <span className="text-sm font-medium">
                      {currentSignal.indicators.ma1 && currentSignal.indicators.ma1 !== null ? 
                        `$${Number(currentSignal.indicators.ma1).toFixed(4)}` : 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">MA2 (21):</span>
                    <span className="text-sm font-medium">
                      {currentSignal.indicators.ma2 && currentSignal.indicators.ma2 !== null ? 
                        `$${Number(currentSignal.indicators.ma2).toFixed(4)}` : 'N/A'}
                    </span>
                  </div>
                </div>
              </div>

              {/* RSI */}
              <div>
                <h4 className="text-sm font-medium text-gray-500 mb-2">RSI</h4>
                <div className="text-2xl font-bold text-gray-900">
                  {currentSignal.indicators.rsi ? Number(currentSignal.indicators.rsi).toFixed(1) : 'N/A'}
                </div>
                <div className="text-sm text-gray-500">
                  {currentSignal.indicators.rsi ? (
                    currentSignal.indicators.rsi <= 30 ? 'Oversold' : 
                    currentSignal.indicators.rsi >= 70 ? 'Overbought' : 'Neutral'
                  ) : 'No data'}
                </div>
              </div>

              {/* Volume */}
              <div>
                <h4 className="text-sm font-medium text-gray-500 mb-2">Volume</h4>
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Current:</span>
                    <span className="text-sm font-medium">
                      {currentSignal.indicators.volume && currentSignal.indicators.volume !== null ? 
                        (Number(currentSignal.indicators.volume) / 1000).toFixed(1) + 'K' : 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Average:</span>
                    <span className="text-sm font-medium">
                      {currentSignal.indicators.avgVolume && currentSignal.indicators.avgVolume !== null ? 
                        (Number(currentSignal.indicators.avgVolume) / 1000).toFixed(1) + 'K' : 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Ratio:</span>
                    <span className={`text-sm font-medium ${
                      currentSignal.indicators.volume && currentSignal.indicators.avgVolume &&
                      currentSignal.indicators.volume !== null && currentSignal.indicators.avgVolume !== null &&
                      currentSignal.indicators.volume / currentSignal.indicators.avgVolume > 1.5 ? 'text-green-600' : 'text-gray-600'
                    }`}>
                      {currentSignal.indicators.volume && currentSignal.indicators.avgVolume && 
                       currentSignal.indicators.volume !== null && currentSignal.indicators.avgVolume !== null ? 
                        (Number(currentSignal.indicators.volume) / Number(currentSignal.indicators.avgVolume)).toFixed(2) + 'x' : 'N/A'
                      }
                    </span>
                  </div>
                </div>
              </div>

              {/* Conditions */}
              <div>
                <h4 className="text-sm font-medium text-gray-500 mb-2">Conditions</h4>
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">MA Cross:</span>
                    <span className={`text-sm ${currentSignal.conditions?.maCrossover ? 'text-green-600' : 'text-gray-400'}`}>
                      {currentSignal.conditions?.maCrossover ? '✓' : '✗'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">RSI Signal:</span>
                    <span className={`text-sm ${currentSignal.conditions?.rsiSignal ? 'text-green-600' : 'text-gray-400'}`}>
                      {currentSignal.conditions?.rsiSignal ? '✓' : '✗'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Volume:</span>
                    <span className={`text-sm ${currentSignal.conditions?.volumeConfirmation ? 'text-green-600' : 'text-gray-400'}`}>
                      {currentSignal.conditions?.volumeConfirmation ? '✓' : '✗'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Trend:</span>
                    <span className={`text-sm ${currentSignal.conditions?.trendAlignment ? 'text-green-600' : 'text-gray-400'}`}>
                      {currentSignal.conditions?.trendAlignment ? '✓' : '✗'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-8 text-center">
              <div className="text-gray-400 text-lg mb-2">Signal Data Unavailable</div>
              <p className="text-gray-500">
                Technical indicators are being calculated. Please wait for market data to be processed.
              </p>
            </div>
          )}

          <div className="mt-4 p-3 bg-gray-50 rounded-lg">
            <p className="text-sm text-gray-700">
              <strong>Reason:</strong> {currentSignal.reason || 'No reason provided'}
            </p>
          </div>
        </div>
      ) : (
        <div className="card p-6">
          <div className="flex items-center justify-center h-32">
            <div className="text-center">
              <div className="text-gray-400 text-lg mb-2">📊</div>
              <div className="text-gray-600">No signal data available</div>
              <div className="text-sm text-gray-500 mt-1">
                Please select a valid symbol to view trading signals
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Live Signals Feed */}
      <div className="card">
        <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
          <h3 className="text-lg font-medium text-gray-900">{t('trading.signals.recentSignals')}</h3>
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-500">{signals.length} signals</span>
            {signals.length > 0 && (
              <button
                onClick={() => setSignals([])}
                className="text-sm text-red-600 hover:text-red-800 px-2 py-1 rounded border border-red-300 hover:bg-red-50"
              >
                {t('common.clear')}
              </button>
            )}
          </div>
        </div>

        <div className="divide-y divide-gray-200">
          {signals.length === 0 ? (
            <div className="p-6 text-center text-gray-500">
              No signals received yet. Signals will appear here as they are generated.
            </div>
          ) : (
            signals.map((signal, index) => {
              const isNew = signal.timestamp && (Date.now() - new Date(signal.timestamp).getTime()) < 30000 // 30 seconds
              return (
                <div key={index} className={`p-4 hover:bg-gray-50 ${isNew ? 'bg-blue-50 border-l-4 border-blue-400' : ''}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-4">
                      <div className="font-medium text-gray-900">{signal.symbol || 'Unknown'}</div>
                      {getActionBadge(signal.action || 'HOLD')}
                      <span className={`font-bold ${getSignalStrengthColor(signal.strength || 0)}`}>
                        {signal.strength || 0}%
                      </span>
                      {isNew && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          NEW
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-gray-500">
                      {signal.timestamp ? new Date(signal.timestamp).toLocaleTimeString() : 'Unknown time'}
                    </div>
                  </div>
                  <div className="mt-2 text-sm text-gray-600">
                    {signal.reason || 'No reason provided'}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}