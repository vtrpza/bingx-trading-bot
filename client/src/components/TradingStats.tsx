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
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 h-full flex flex-col">
      <div className="px-4 py-3 border-b border-gray-200 flex justify-between items-center">
        <h3 className="text-lg font-medium text-gray-900">Trading Statistics</h3>
        
        <div className="flex space-x-1">
          {['24h', '7d', '30d', 'all'].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-2 py-1 text-xs rounded ${
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

      <div className="p-4 flex-1 overflow-y-auto">
        <div className="grid grid-cols-1 gap-4">
          {/* Compact Metrics Grid */}
          <div className="grid grid-cols-2 gap-3">
            {/* Total Trades */}
            <div className="text-center bg-gray-50 rounded-lg p-3">
              <div className="text-xl font-bold text-gray-900">{stats.totalTrades || 0}</div>
              <div className="text-xs text-gray-500">Total Trades</div>
            </div>

            {/* Win Rate */}
            <div className="text-center bg-green-50 rounded-lg p-3">
              <div className="text-xl font-bold text-green-600">{stats.winRate || '0'}%</div>
              <div className="text-xs text-gray-500">Win Rate</div>
              <div className="text-xs text-gray-400 mt-1">
                {stats.winningTrades || 0}W / {stats.losingTrades || 0}L
              </div>
            </div>

            {/* Total P&L */}
            <div className={`text-center rounded-lg p-3 ${
              parseFloat(stats.totalPnl || '0') >= 0 ? 'bg-green-50' : 'bg-red-50'
            }`}>
              <div className={`text-xl font-bold ${
                parseFloat(stats.totalPnl || '0') >= 0 ? 'text-green-600' : 'text-red-600'
              }`}>
                {formatCurrency(stats.totalPnl || '0.00')}
              </div>
              <div className="text-xs text-gray-500">Total P&L</div>
            </div>

            {/* Average P&L */}
            <div className={`text-center rounded-lg p-3 ${
              parseFloat(stats.averagePnl || '0') >= 0 ? 'bg-green-50' : 'bg-red-50'
            }`}>
              <div className={`text-xl font-bold ${
                parseFloat(stats.averagePnl || '0') >= 0 ? 'text-green-600' : 'text-red-600'
              }`}>
                {formatCurrency(stats.averagePnl || '0.00')}
              </div>
              <div className="text-xs text-gray-500">Avg P&L</div>
            </div>
          </div>

          {/* Volume - Full Width */}
          <div className="text-center bg-blue-50 rounded-lg p-3">
            <div className="text-xl font-bold text-blue-600">
              ${formatNumber(parseFloat(stats.totalVolume || '0'))}
            </div>
            <div className="text-xs text-gray-500">Total Volume</div>
          </div>
        </div>

        {/* Bot Status - Compact */}
        {stats.bot && (
          <div className="mt-4 pt-3 border-t border-gray-200">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <div className={`w-2 h-2 rounded-full ${
                  stats.bot.isRunning ? 'bg-green-500' : 'bg-gray-400'
                }`}></div>
                <span className="text-xs text-gray-600">
                  {stats.bot.isRunning ? 'Running' : 'Stopped'}
                </span>
              </div>
              <div className="text-xs text-gray-600">
                {stats.bot.architecture}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}