import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { api } from '../services/api'
import type { Position } from '../types'

interface PositionsTableProps {
  positions: Position[]
}

export default function PositionsTable({ positions }: PositionsTableProps) {
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)
  const [closePercentage, setClosePercentage] = useState(100)
  const [loading, setLoading] = useState(false)
  const queryClient = useQueryClient()

  // Close position mutation
  const closePositionMutation = useMutation(
    async ({ symbol, percentage }: { symbol: string; percentage: number }) => {
      const response = await fetch(`/api/trading/parallel-bot/positions/${symbol}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          reason: 'Manual close', 
          percentage 
        })
      })
      if (!response.ok) throw new Error('Failed to close position')
      return response.json()
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries('positions')
        setSelectedSymbol(null)
        setClosePercentage(100)
      }
    }
  )

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

  // Debug logging
  console.log('PositionsTable Debug:', {
    realTimePositions,
    propsPositions: positions,
    displayPositions,
    samplePosition: displayPositions[0]
  })

  const formatNumber = (value: number | string, decimals = 4) => {
    const numValue = Number(value)
    if (isNaN(numValue)) return '0.0000'
    return numValue.toFixed(decimals)
  }

  const formatPercent = (value: number | string) => {
    const numValue = Number(value)
    if (isNaN(numValue)) return '0.00%'
    const formatted = numValue.toFixed(2)
    return numValue >= 0 ? `+${formatted}%` : `${formatted}%`
  }

  const formatCurrency = (value: number | string, currency = 'USDT') => {
    const numValue = Number(value)
    if (isNaN(numValue)) return '0.00 ' + currency
    const formatted = numValue.toFixed(2)
    return numValue >= 0 ? `+${formatted} ${currency}` : `${formatted} ${currency}`
  }

  const handleClosePosition = async () => {
    if (!selectedSymbol) return
    
    setLoading(true)
    try {
      await closePositionMutation.mutateAsync({
        symbol: selectedSymbol,
        percentage: closePercentage
      })
    } catch (error) {
      console.error('Error closing position:', error)
    } finally {
      setLoading(false)
    }
  }

  const selectedPosition = displayPositions.find(p => p.symbol === selectedSymbol)

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
              // Safe parsing with fallbacks
              const positionAmt = Number(position.positionAmt) || 0
              const isLong = positionAmt > 0
              const size = Math.abs(positionAmt)
              const entryPrice = Number(position.entryPrice) || 0
              const markPrice = Number(position.markPrice) || 0
              const unrealizedPnl = Number(position.unrealizedProfit) || 0
              const roe = Number(position.percentage) || 0

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

      {/* Position Management Modal */}
      {selectedSymbol && selectedPosition && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-lg w-full mx-4">
            <div className="flex justify-between items-center mb-6">
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
            
            {/* Position Summary */}
            <div className="bg-gray-50 rounded-lg p-4 mb-6">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">Side:</span>
                  <span className={`ml-2 font-medium ${
                    Number(selectedPosition.positionAmt) > 0 ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {Number(selectedPosition.positionAmt) > 0 ? 'LONG' : 'SHORT'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Size:</span>
                  <span className="ml-2 font-medium">
                    {formatNumber(Math.abs(Number(selectedPosition.positionAmt)), 6)}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">Entry:</span>
                  <span className="ml-2 font-medium">
                    ${formatNumber(selectedPosition.entryPrice)}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500">PnL:</span>
                  <span className={`ml-2 font-medium ${
                    Number(selectedPosition.unrealizedProfit) >= 0 ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {formatCurrency(selectedPosition.unrealizedProfit)}
                  </span>
                </div>
              </div>
            </div>

            {/* Close Position Controls */}
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Close Percentage
                </label>
                <div className="flex items-center space-x-4">
                  <input
                    type="range"
                    min="1"
                    max="100"
                    value={closePercentage}
                    onChange={(e) => setClosePercentage(Number(e.target.value))}
                    className="flex-1"
                  />
                  <div className="flex items-center space-x-2">
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={closePercentage}
                      onChange={(e) => setClosePercentage(Number(e.target.value))}
                      className="w-16 px-2 py-1 border border-gray-300 rounded text-sm"
                    />
                    <span className="text-sm text-gray-500">%</span>
                  </div>
                </div>
                <div className="flex justify-between mt-2">
                  <button
                    onClick={() => setClosePercentage(25)}
                    className="text-xs px-2 py-1 bg-gray-100 rounded hover:bg-gray-200"
                  >
                    25%
                  </button>
                  <button
                    onClick={() => setClosePercentage(50)}
                    className="text-xs px-2 py-1 bg-gray-100 rounded hover:bg-gray-200"
                  >
                    50%
                  </button>
                  <button
                    onClick={() => setClosePercentage(75)}
                    className="text-xs px-2 py-1 bg-gray-100 rounded hover:bg-gray-200"
                  >
                    75%
                  </button>
                  <button
                    onClick={() => setClosePercentage(100)}
                    className="text-xs px-2 py-1 bg-gray-100 rounded hover:bg-gray-200"
                  >
                    100%
                  </button>
                </div>
              </div>

              {closePercentage < 100 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                  <p className="text-sm text-blue-800">
                    <strong>Partial Close:</strong> {closePercentage}% of position will be closed
                    ({formatNumber(Math.abs(Number(selectedPosition.positionAmt)) * closePercentage / 100, 6)} tokens)
                  </p>
                </div>
              )}
              
              {/* Action Buttons */}
              <div className="flex justify-end space-x-3 pt-4">
                <button
                  onClick={() => setSelectedSymbol(null)}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
                  disabled={loading}
                >
                  Cancel
                </button>
                <button
                  onClick={handleClosePosition}
                  disabled={loading || closePositionMutation.isLoading}
                  className={`px-4 py-2 text-white rounded-lg ${
                    closePercentage === 100 
                      ? 'bg-red-600 hover:bg-red-700' 
                      : 'bg-orange-600 hover:bg-orange-700'
                  } disabled:opacity-50`}
                >
                  {loading || closePositionMutation.isLoading ? (
                    <span className="flex items-center">
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Closing...
                    </span>
                  ) : (
                    `Close ${closePercentage}% Position`
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}