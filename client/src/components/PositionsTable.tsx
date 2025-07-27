import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { api } from '../services/api'
import type { Position } from '../types'

interface ToastMessage {
  id: string
  type: 'success' | 'error' | 'warning'
  message: string
}

interface PositionsTableProps {
  positions: Position[]
}

export default function PositionsTable({ positions }: PositionsTableProps) {
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)
  const [closePercentage, setClosePercentage] = useState(100)
  const [loading, setLoading] = useState(false)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [showConfirmation, setShowConfirmation] = useState(false)
  const queryClient = useQueryClient()

  // Use shared bot status query  
  const { data: botStatus } = useQuery(
    'bot-status',
    api.getBotStatus,
    {
      refetchInterval: 5000,
      retry: 1,
      onError: () => {
        // Silent fail for status check
      }
    }
  )

  const isBotRunning = botStatus?.isRunning === true

  // DEBUG: Log bot status for troubleshooting
  console.log('Bot status check:', { 
    botStatus, 
    isRunning: botStatus?.isRunning, 
    isBotRunning 
  })

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
      onSuccess: (data) => {
        queryClient.invalidateQueries('positions')
        setSelectedSymbol(null)
        setClosePercentage(100)
        setShowConfirmation(false)
        
        // Success toast
        addToast('success', `Position ${data.data.symbol} closed successfully (${data.data.percentage}%)`)
        
        // Optimistic UI update - remove from list if 100% closed
        if (data.data.percentage === 100) {
          setTimeout(() => {
            queryClient.setQueryData('positions', (oldData: any) => {
              if (Array.isArray(oldData)) {
                return oldData.filter((pos: Position) => pos.symbol !== data.data.symbol)
              }
              return oldData
            })
          }, 1000) // Small delay to show toast first
        }
      },
      onError: (error: any) => {
        addToast('error', `Failed to close position: ${error.message}`)
      }
    }
  )

  // Toast management
  const addToast = (type: ToastMessage['type'], message: string) => {
    const id = Math.random().toString(36).substring(7)
    setToasts(prev => [...prev, { id, type, message }])
    
    // Auto remove after 5 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(toast => toast.id !== id))
    }, 5000)
  }

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(toast => toast.id !== id))
  }

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

  const handleManageClick = (symbol: string) => {
    if (!isBotRunning) {
      addToast('warning', 'Bot precisa estar rodando para gerenciar posições.')
      return
    }
    setSelectedSymbol(symbol)
    setShowConfirmation(false)
  }

  const handleConfirmClose = () => {
    setShowConfirmation(false)
    handleClosePosition()
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
                      onClick={() => handleManageClick(position.symbol)}
                      className="px-3 py-1 rounded text-sm font-medium transition-colors text-primary-600 hover:text-primary-900 hover:bg-primary-50"
                      title="Gerenciar posição"
                    >
                      Gerenciar
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
                  onClick={() => setShowConfirmation(true)}
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

      {/* Confirmation Dialog */}
      {showConfirmation && selectedSymbol && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <div className="flex items-center mb-4">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.996-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <div className="ml-3">
                <h3 className="text-lg font-medium text-gray-900">
                  Confirm Position Close
                </h3>
              </div>
            </div>
            
            <div className="mb-4">
              <p className="text-sm text-gray-600">
                Are you sure you want to close <strong>{closePercentage}%</strong> of your <strong>{selectedSymbol}</strong> position?
              </p>
              {closePercentage === 100 && (
                <p className="text-sm text-red-600 mt-2">
                  ⚠️ This will completely close the position and remove it from your portfolio.
                </p>
              )}
            </div>
            
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowConfirmation(false)}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmClose}
                className={`px-4 py-2 text-white rounded-lg ${
                  closePercentage === 100 
                    ? 'bg-red-600 hover:bg-red-700' 
                    : 'bg-orange-600 hover:bg-orange-700'
                }`}
              >
                Yes, Close Position
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notifications */}
      <div className="fixed top-4 right-4 z-50 space-y-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`max-w-sm w-full shadow-lg rounded-lg pointer-events-auto overflow-hidden ${
              toast.type === 'success' 
                ? 'bg-green-500' 
                : toast.type === 'error' 
                ? 'bg-red-500' 
                : 'bg-yellow-500'
            }`}
          >
            <div className="p-4">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  {toast.type === 'success' && (
                    <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  )}
                  {toast.type === 'error' && (
                    <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                    </svg>
                  )}
                  {toast.type === 'warning' && (
                    <svg className="h-5 w-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  )}
                </div>
                <div className="ml-3 w-0 flex-1">
                  <p className="text-sm font-medium text-white">
                    {toast.message}
                  </p>
                </div>
                <div className="ml-4 flex-shrink-0 flex">
                  <button
                    onClick={() => removeToast(toast.id)}
                    className="rounded-md inline-flex text-white hover:text-gray-200 focus:outline-none"
                  >
                    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}