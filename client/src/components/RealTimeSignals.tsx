import { useState, useEffect } from 'react'
import { useQuery } from 'react-query'
import { api } from '../services/api'
import { useWebSocket } from '../hooks/useWebSocket'
import type { TradingSignal } from '../types'

export default function RealTimeSignals() {
  const [signals, setSignals] = useState<TradingSignal[]>([])
  const [selectedSymbol, setSelectedSymbol] = useState('BTC-USDT')
  const [watchedSymbols] = useState(['BTC-USDT', 'ETH-USDT', 'BNB-USDT'])

  const { lastMessage } = useWebSocket('/ws')

  // Get market overview for popular symbols
  const { data: marketOverview } = useQuery('market-overview', api.getMarketOverview)

  // Get signal for selected symbol
  const { data: currentSignal } = useQuery(
    ['signal', selectedSymbol],
    () => api.getSignal(selectedSymbol),
    {
      refetchInterval: 10000, // Refresh every 10 seconds
    }
  )

  useEffect(() => {
    if (lastMessage) {
      const data = JSON.parse(lastMessage.data)
      
      if (data.type === 'signal') {
        // Add new signal to the list
        setSignals(prev => [data.data, ...prev.slice(0, 19)]) // Keep only 20 latest signals
      }
    }
  }, [lastMessage])

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
      {/* Symbol Selection */}
      <div className="card p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Signal Analysis</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="label">Select Symbol</label>
            <select
              value={selectedSymbol}
              onChange={(e) => setSelectedSymbol(e.target.value)}
              className="input"
            >
              {marketOverview?.topVolume?.map((item: any) => (
                <option key={item.symbol} value={item.symbol}>
                  {item.symbol} (Vol: ${(Number(item.volume) / 1000000).toFixed(1)}M)
                </option>
              ))}
            </select>
          </div>
          
          <div>
            <label className="label">Watched Symbols</label>
            <div className="flex flex-wrap gap-2">
              {watchedSymbols.map((symbol) => (
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
      {currentSignal && (
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

          {currentSignal.indicators && Object.keys(currentSignal.indicators).length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {/* Price Info */}
              <div>
                <h4 className="text-sm font-medium text-gray-500 mb-2">Price Info</h4>
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Current:</span>
                    <span className="text-sm font-medium">
                      ${currentSignal.indicators.price ? Number(currentSignal.indicators.price).toFixed(4) : 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">MA1 (9):</span>
                    <span className="text-sm font-medium">
                      ${currentSignal.indicators.ma1 ? Number(currentSignal.indicators.ma1).toFixed(4) : 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">MA2 (21):</span>
                    <span className="text-sm font-medium">
                      ${currentSignal.indicators.ma2 ? Number(currentSignal.indicators.ma2).toFixed(4) : 'N/A'}
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
                      {currentSignal.indicators.volume ? (Number(currentSignal.indicators.volume) / 1000).toFixed(1) + 'K' : 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Average:</span>
                    <span className="text-sm font-medium">
                      {currentSignal.indicators.avgVolume ? (Number(currentSignal.indicators.avgVolume) / 1000).toFixed(1) + 'K' : 'N/A'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-600">Ratio:</span>
                    <span className={`text-sm font-medium ${
                      currentSignal.indicators.volume && currentSignal.indicators.avgVolume &&
                      currentSignal.indicators.volume / currentSignal.indicators.avgVolume > 1.5 ? 'text-green-600' : 'text-gray-600'
                    }`}>
                      {currentSignal.indicators.volume && currentSignal.indicators.avgVolume ? 
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
      )}

      {/* Live Signals Feed */}
      <div className="card">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-medium text-gray-900">Live Signals Feed</h3>
        </div>

        <div className="divide-y divide-gray-200">
          {signals.length === 0 ? (
            <div className="p-6 text-center text-gray-500">
              No signals received yet. Signals will appear here as they are generated.
            </div>
          ) : (
            signals.map((signal, index) => (
              <div key={index} className="p-4 hover:bg-gray-50">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-4">
                    <div className="font-medium text-gray-900">{signal.symbol || 'Unknown'}</div>
                    {getActionBadge(signal.action || 'HOLD')}
                    <span className={`font-bold ${getSignalStrengthColor(signal.strength || 0)}`}>
                      {signal.strength || 0}%
                    </span>
                  </div>
                  <div className="text-sm text-gray-500">
                    {signal.timestamp ? new Date(signal.timestamp).toLocaleTimeString() : 'Unknown time'}
                  </div>
                </div>
                <div className="mt-2 text-sm text-gray-600">
                  {signal.reason || 'No reason provided'}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}