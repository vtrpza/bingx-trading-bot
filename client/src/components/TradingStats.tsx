import { useState } from 'react'
import { useQuery } from 'react-query'
import { api } from '../services/api'

interface TradingStatsProps {
  stats?: any
}

export default function TradingStats({ stats: initialStats }: TradingStatsProps) {
  const [period, setPeriod] = useState('24h')

  // Get trading statistics for different periods
  const { data: stats, error, isLoading } = useQuery(
    ['trading-stats', period],
    () => api.getTradingStats(period),
    {
      initialData: period === '24h' ? initialStats : undefined,
      refetchInterval: 30000,
      retry: 3,
      onError: (error) => {
        console.error('Failed to fetch trading stats:', error)
      }
    }
  )
  
  console.log('Trading Stats Debug:', { stats, error, isLoading, period })
  
  if (error) {
    return (
      <div className="card p-6">
        <div className="text-center text-red-500">
          Error loading trading statistics: {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      </div>
    )
  }
  
  if (isLoading || !stats) {
    return (
      <div className="card p-6">
        <div className="text-center text-gray-500">Loading trading statistics...</div>
      </div>
    )
  }

  const formatCurrency = (value: string) => {
    const num = parseFloat(value)
    return num >= 0 ? `+${value}` : value
  }

  const formatNumber = (value: number | string) => {
    const numValue = Number(value)
    if (numValue >= 1000000) {
      return (numValue / 1000000).toFixed(1) + 'M'
    }
    if (numValue >= 1000) {
      return (numValue / 1000).toFixed(1) + 'K'
    }
    return numValue.toString()
  }

  return (
    <div className="card">
      <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
        <h3 className="text-lg font-medium text-gray-900">Trading Statistics</h3>
        
        <div className="flex space-x-2">
          {['24h', '7d', '30d', 'all'].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1 text-sm rounded ${
                period === p
                  ? 'bg-primary-100 text-primary-700'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {p === 'all' ? 'All Time' : p.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-6">
          {/* Total Trades */}
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-900">{stats.totalTrades || 0}</div>
            <div className="text-sm text-gray-500">Total Trades</div>
          </div>

          {/* Win Rate */}
          <div className="text-center">
            <div className="text-2xl font-bold text-green-600">{stats.winRate || '0'}%</div>
            <div className="text-sm text-gray-500">Win Rate</div>
            <div className="text-xs text-gray-400 mt-1">
              {stats.winningTrades || 0}W / {stats.losingTrades || 0}L
            </div>
          </div>

          {/* Total P&L */}
          <div className="text-center">
            <div className={`text-2xl font-bold ${
              parseFloat(stats.totalPnl || '0') >= 0 ? 'text-green-600' : 'text-red-600'
            }`}>
              {formatCurrency(stats.totalPnl || '0.00')}
            </div>
            <div className="text-sm text-gray-500">Total P&L</div>
          </div>

          {/* Average P&L */}
          <div className="text-center">
            <div className={`text-2xl font-bold ${
              parseFloat(stats.averagePnl || '0') >= 0 ? 'text-green-600' : 'text-red-600'
            }`}>
              {formatCurrency(stats.averagePnl || '0.00')}
            </div>
            <div className="text-sm text-gray-500">Avg P&L</div>
          </div>

          {/* Total Volume */}
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-900">
              ${formatNumber(parseFloat(stats.totalVolume || '0'))}
            </div>
            <div className="text-sm text-gray-500">Volume</div>
          </div>
        </div>

        {/* Position Management Section - Show if parallel bot data available */}
        {stats.positions && (
          <div className="mt-8 pt-6 border-t border-gray-200">
            <h4 className="text-lg font-medium text-gray-900 mb-4">Position Management</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              <div className="text-center">
                <div className="text-xl font-bold text-blue-600">{stats.positions.currentActive}</div>
                <div className="text-sm text-gray-500">Active Positions</div>
              </div>
              <div className="text-center">
                <div className="text-xl font-bold text-gray-900">{stats.positions.metrics.totalPositions}</div>
                <div className="text-sm text-gray-500">Total Managed</div>
              </div>
              <div className="text-center">
                <div className="text-xl font-bold text-green-600">{stats.positions.metrics.winRate.toFixed(1)}%</div>
                <div className="text-sm text-gray-500">Position Win Rate</div>
              </div>
              <div className="text-center">
                <div className={`text-xl font-bold ${
                  stats.positions.metrics.totalPnL >= 0 ? 'text-green-600' : 'text-red-600'
                }`}>
                  {formatCurrency(stats.positions.metrics.totalPnL.toFixed(2))}
                </div>
                <div className="text-sm text-gray-500">Position P&L</div>
              </div>
            </div>
          </div>
        )}

        {/* Bot Status Section - Show architecture info */}
        {stats.bot && (
          <div className="mt-6 pt-6 border-t border-gray-200">
            <div className="flex justify-between items-center">
              <h4 className="text-lg font-medium text-gray-900">Bot Status</h4>
              <div className="flex items-center space-x-4">
                <div className="flex items-center">
                  <div className={`w-3 h-3 rounded-full mr-2 ${
                    stats.bot.isRunning ? 'bg-green-500' : 'bg-gray-400'
                  }`}></div>
                  <span className="text-sm text-gray-600">
                    {stats.bot.isRunning ? 'Running' : 'Stopped'}
                  </span>
                </div>
                <div className="text-sm text-gray-600">
                  Architecture: <span className="font-medium">{stats.bot.architecture}</span>
                </div>
                {stats.bot.immediateExecution !== undefined && (
                  <div className="text-sm text-gray-600">
                    Immediate Execution: <span className="font-medium">
                      {stats.bot.immediateExecution ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Best and Worst Trades */}
        {(stats.bestTrade || stats.worstTrade) && (
          <div className="mt-8 pt-6 border-t border-gray-200">
            <h4 className="text-lg font-medium text-gray-900 mb-4">Trade Performance</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {stats.bestTrade && (
                <div className="bg-green-50 rounded-lg p-4">
                  <h5 className="font-medium text-green-900 mb-2">Best Trade</h5>
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-green-700">Symbol:</span>
                      <span className="font-medium text-green-900">{stats.bestTrade.symbol}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-green-700">P&L:</span>
                      <span className="font-bold text-green-600">
                        +{stats.bestTrade.pnl}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-green-700">Date:</span>
                      <span className="text-green-900">
                        {new Date(stats.bestTrade.date).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {stats.worstTrade && (
                <div className="bg-red-50 rounded-lg p-4">
                  <h5 className="font-medium text-red-900 mb-2">Worst Trade</h5>
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-red-700">Symbol:</span>
                      <span className="font-medium text-red-900">{stats.worstTrade.symbol}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-red-700">P&L:</span>
                      <span className="font-bold text-red-600">
                        {stats.worstTrade.pnl}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-red-700">Date:</span>
                      <span className="text-red-900">
                        {new Date(stats.worstTrade.date).toLocaleDateString()}
                      </span>
                    </div>
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