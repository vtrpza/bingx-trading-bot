import { useState } from 'react'
import { useQuery } from 'react-query'
import { api } from '../services/api'
import type { Position } from '../types'

interface PositionsTableProps {
  positions: Position[]
}

export default function PositionsTable({ positions }: PositionsTableProps) {
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)

  // Get real-time positions from API
  const { data: realTimePositions, error } = useQuery(
    'positions',
    api.getPositions,
    {
      refetchInterval: 30000,
      onError: (error) => {
        console.error('Failed to fetch positions:', error)
      }
    }
  )

  // Ensure we always have a valid array
  const displayPositions = Array.isArray(realTimePositions) 
    ? realTimePositions 
    : Array.isArray(positions) 
      ? positions 
      : []

  const formatNumber = (value: number | string, decimals = 4) => {
    return Number(value).toFixed(decimals)
  }

  const formatPercent = (value: number | string) => {
    const numValue = Number(value)
    const formatted = numValue.toFixed(2)
    return numValue >= 0 ? `+${formatted}%` : `${formatted}%`
  }

  const formatCurrency = (value: number | string, currency = 'USDT') => {
    const numValue = Number(value)
    const formatted = numValue.toFixed(2)
    return numValue >= 0 ? `+${formatted} ${currency}` : `${formatted} ${currency}`
  }

  // Show error state if API failed
  if (error) {
    return (
      <div className="card p-8">
        <div className="text-center">
          <div className="text-red-400 text-lg mb-2">⚠️ Error Loading Positions</div>
          <p className="text-gray-500">
            Unable to fetch position data. The bot may still be running normally.
          </p>
        </div>
      </div>
    )
  }

  if (!displayPositions || displayPositions.length === 0) {
    return (
      <div className="card p-8">
        <div className="text-center">
          <div className="text-gray-400 text-lg mb-2">No Active Positions</div>
          <p className="text-gray-500">
            The bot will automatically open positions when trading signals are detected.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200">
        <h3 className="text-lg font-medium text-gray-900">
          Active Positions ({displayPositions.length})
        </h3>
      </div>
      
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Symbol
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Side
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Size
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Entry Price
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Mark Price
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Unrealized PnL
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                ROE %
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {Array.isArray(displayPositions) && displayPositions.map((position, index) => {
              const isLong = parseFloat(position.positionAmt) > 0
              const size = Math.abs(parseFloat(position.positionAmt))
              const entryPrice = parseFloat(position.entryPrice)
              const markPrice = parseFloat(position.markPrice)
              const unrealizedPnl = parseFloat(position.unrealizedProfit)
              const roe = parseFloat(position.percentage)

              return (
                <tr key={`${position.symbol}-${index}`} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="font-medium text-gray-900">{position.symbol}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                      isLong 
                        ? 'bg-green-100 text-green-800' 
                        : 'bg-red-100 text-red-800'
                    }`}>
                      {isLong ? 'LONG' : 'SHORT'}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {formatNumber(size, 6)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    ${formatNumber(entryPrice)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    ${formatNumber(markPrice)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`text-sm font-medium ${
                      unrealizedPnl >= 0 ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {formatCurrency(unrealizedPnl)}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`text-sm font-medium ${
                      roe >= 0 ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {formatPercent(roe)}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    <button
                      onClick={() => setSelectedSymbol(position.symbol)}
                      className="text-primary-600 hover:text-primary-900"
                    >
                      Manage
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Position Details Modal */}
      {selectedSymbol && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium text-gray-900">
                Manage Position: {selectedSymbol}
              </h3>
              <button
                onClick={() => setSelectedSymbol(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>
            
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                Position management features will be available in the next update.
                For now, positions are managed automatically by the trading bot.
              </p>
              
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => setSelectedSymbol(null)}
                  className="btn btn-secondary"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}