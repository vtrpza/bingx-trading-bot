import { useState } from 'react'
import { useQuery } from 'react-query'
import { api } from '../services/api'
import { format } from 'date-fns'
import { useLocalStorage } from '../hooks/useLocalStorage'
import type { Trade } from '../types'

export default function TradeHistory() {
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useLocalStorage('tradeHistoryFilters', {
    symbol: '',
    status: '',
    startDate: '',
    endDate: ''
  })

  // Get trade history
  const { data: tradesData, isLoading } = useQuery(
    ['trade-history', page, filters],
    () => api.getTradeHistory({
      page,
      limit: 20,
      ...filters
    }),
    {
      keepPreviousData: true,
    }
  )

  const trades = tradesData?.trades || []
  const pagination = tradesData?.pagination

  const formatCurrency = (value: number | string) => {
    const numValue = Number(value)
    const formatted = numValue.toFixed(2)
    return numValue >= 0 ? `+${formatted}` : `${formatted}`
  }

  const getStatusBadge = (status: string) => {
    const statusConfig = {
      'FILLED': { bg: 'bg-green-100', text: 'text-green-800' },
      'NEW': { bg: 'bg-blue-100', text: 'text-blue-800' },
      'PARTIALLY_FILLED': { bg: 'bg-yellow-100', text: 'text-yellow-800' },
      'CANCELED': { bg: 'bg-gray-100', text: 'text-gray-800' },
      'REJECTED': { bg: 'bg-red-100', text: 'text-red-800' },
      'EXPIRED': { bg: 'bg-red-100', text: 'text-red-800' }
    }

    const config = statusConfig[status as keyof typeof statusConfig] || statusConfig['NEW']
    
    return (
      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${config.bg} ${config.text}`}>
        {status}
      </span>
    )
  }

  return (
    <div className="card">
      <div className="px-6 py-4 border-b border-gray-200">
        <h3 className="text-lg font-medium text-gray-900">Histórico de Trades</h3>
      </div>

      {/* Filters */}
      <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Símbolo</label>
            <input
              type="text"
              value={filters.symbol}
              onChange={(e) => setFilters({ ...filters, symbol: e.target.value })}
              placeholder="ex: BTC-USDT"
              className="input"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              className="input"
            >
              <option value="">Todos</option>
              <option value="FILLED">Executado</option>
              <option value="NEW">Novo</option>
              <option value="PARTIALLY_FILLED">Parcialmente Executado</option>
              <option value="CANCELED">Cancelado</option>
              <option value="REJECTED">Rejeitado</option>
            </select>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Data Inicial</label>
            <input
              type="date"
              value={filters.startDate}
              onChange={(e) => setFilters({ ...filters, startDate: e.target.value })}
              className="input"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Data Final</label>
            <input
              type="date"
              value={filters.endDate}
              onChange={(e) => setFilters({ ...filters, endDate: e.target.value })}
              className="input"
            />
          </div>
        </div>
      </div>

      {/* Trade Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Data/Hora
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Símbolo
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Lado
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Tipo
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Quantidade
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Preço
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                P&L
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Sinal
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {isLoading ? (
              <tr>
                <td colSpan={9} className="px-6 py-4 text-center text-gray-500">
                  Carregando trades...
                </td>
              </tr>
            ) : trades.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-6 py-4 text-center text-gray-500">
                  Nenhum trade encontrado
                </td>
              </tr>
            ) : (
              trades.map((trade: Trade) => (
                <tr key={trade.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {format(new Date(trade.createdAt), 'MMM dd, HH:mm')}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="font-medium text-gray-900">{trade.symbol}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                      trade.side === 'BUY' 
                        ? 'bg-green-100 text-green-800' 
                        : 'bg-red-100 text-red-800'
                    }`}>
                      {trade.side}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {trade.type}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {Number(trade.executedQty).toFixed(6)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    ${Number(trade.avgPrice) > 0 ? Number(trade.avgPrice).toFixed(4) : Number(trade.price).toFixed(4)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {trade.status === 'FILLED' ? (
                      <span className={`text-sm font-medium ${
                        trade.realizedPnl >= 0 ? 'text-green-600' : 'text-red-600'
                      }`}>
                        {formatCurrency(trade.realizedPnl)}
                      </span>
                    ) : (
                      <span className="text-sm text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {getStatusBadge(trade.status)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-gray-900">
                      {trade.signalStrength}%
                    </div>
                    <div className="text-xs text-gray-500 max-w-32 truncate" title={trade.signalReason}>
                      {trade.signalReason}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="bg-white px-4 py-3 border-t border-gray-200 sm:px-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-700">
                Mostrando {((page - 1) * 20) + 1} a {Math.min(page * 20, pagination.total)} de{' '}
                {pagination.total} resultados
              </p>
            </div>
            <div>
              <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px">
                <button
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page === 1}
                  className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                >
                  Anterior
                </button>
                
                <span className="relative inline-flex items-center px-4 py-2 border border-gray-300 bg-white text-sm font-medium text-gray-700">
                  Página {page} de {pagination.totalPages}
                </span>
                
                <button
                  onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
                  disabled={page === pagination.totalPages}
                  className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                >
                  Próximo
                </button>
              </nav>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}