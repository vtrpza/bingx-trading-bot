import { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { api } from '../services/api'
import { toast } from 'react-hot-toast'
import type { Asset } from '../types'
import { useTranslation } from '../hooks/useTranslation'

export default function AssetsPage() {
  const [page, setPage] = useState(1)
  const [limit] = useState(20)
  const [sortBy, setSortBy] = useState('quoteVolume24h')
  const [sortOrder, setSortOrder] = useState<'ASC' | 'DESC'>('DESC')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('TRADING')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshProgress, setRefreshProgress] = useState({ progress: 0, message: '', processed: 0, total: 0 })
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  // Get assets data
  const { data: assetsData, isLoading, refetch } = useQuery(
    ['assets', page, limit, sortBy, sortOrder, search, status],
    () => api.getAssets({ page, limit, sortBy, sortOrder, search, status }),
    {
      keepPreviousData: true,
    }
  )

  // Get asset statistics
  const { data: stats } = useQuery('asset-stats', api.getAssetStats, {
    onSuccess: (data) => {
      console.log('Asset stats received:', data)
    }
  })


  const assets = assetsData?.assets || []
  const pagination = assetsData?.pagination

  // Handle sort
  const handleSort = (column: string) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'ASC' ? 'DESC' : 'ASC')
    } else {
      setSortBy(column)
      setSortOrder('DESC')
    }
    setPage(1)
  }

  // Handle refresh
  const handleRefresh = async () => {
    setIsRefreshing(true)
    setRefreshProgress({ progress: 0, message: 'Starting refresh...', processed: 0, total: 0 })
    toast.loading('Refreshing assets from BingX...', { id: 'refresh-assets' })
    
    try {
      await api.refreshAssets((progressData) => {
        // Update progress state
        setRefreshProgress({
          progress: progressData.progress || 0,
          message: progressData.message || '',
          processed: progressData.processed || 0,
          total: progressData.total || 0
        })
        
        // Update toast with progress
        if (progressData.type === 'progress') {
          toast.loading(
            `${progressData.message || 'Processando...'}\nProgresso: ${progressData.progress || 0}%`,
            { id: 'refresh-assets' }
          )
        } else if (progressData.type === 'completed') {
          toast.success(
            `Ativos atualizados com sucesso!\n${progressData.created || 0} criados, ${progressData.updated || 0} atualizados\n${progressData.processed || 0} processados, ${progressData.skipped || 0} ignorados de ${progressData.total || 0} contratos totais`,
            { 
              id: 'refresh-assets',
              duration: 5000 
            }
          )
          
          // Invalidate and refetch all related queries after completion
          queryClient.invalidateQueries(['assets'])
          queryClient.invalidateQueries('asset-stats')
        } else if (progressData.type === 'error') {
          toast.error(progressData.message || 'Erro durante a atualização', { id: 'refresh-assets' })
        }
      })
      
      // Additional manual refetch as backup
      await refetch()
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Falha ao atualizar ativos'
      toast.error(errorMessage, { id: 'refresh-assets' })
    } finally {
      setIsRefreshing(false)
      setRefreshProgress({ progress: 0, message: '', processed: 0, total: 0 })
      
      // Ensure cache invalidation happens even on error for consistency
      queryClient.invalidateQueries(['assets'])
      queryClient.invalidateQueries('asset-stats')
    }
  }

  // Format number
  const formatNumber = (value: number | string, decimals = 2) => {
    const numValue = Number(value)
    if (numValue >= 1e9) return (numValue / 1e9).toFixed(1) + 'B'
    if (numValue >= 1e6) return (numValue / 1e6).toFixed(1) + 'M'
    if (numValue >= 1e3) return (numValue / 1e3).toFixed(1) + 'K'
    return numValue.toFixed(decimals)
  }

  // Format percentage
  const formatPercent = (value: number | string) => {
    const numValue = Number(value)
    const formatted = numValue.toFixed(2)
    return numValue >= 0 ? `+${formatted}%` : `${formatted}%`
  }

  // Format date in UTC-3 (Brazil timezone)
  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    // Convert to UTC-3 (Brazil timezone)
    const utcMinus3 = new Date(date.getTime() - (3 * 60 * 60 * 1000))
    return utcMinus3.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }


  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Asset Analysis</h1>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className={`btn flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-all ${
            isRefreshing 
              ? 'bg-blue-100 text-blue-700 border border-blue-300 cursor-not-allowed' 
              : 'bg-blue-600 text-white hover:bg-blue-700 border border-blue-600'
          }`}
        >
          {isRefreshing ? (
            <>
              <div className="w-4 h-4 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin"></div>
              <span>🔄 Atualizando...</span>
            </>
          ) : (
            <>
              <span>🔄</span>
              <span>Atualizar Dados</span>
            </>
          )}
        </button>
      </div>

      {/* Scan Status */}
      {isRefreshing && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-6">
          <div className="flex items-center justify-center space-x-3">
            <div className="relative">
              <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
              <div className="absolute inset-0 w-8 h-8 border-4 border-transparent border-t-blue-400 rounded-full animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }}></div>
            </div>
            <div className="text-center">
              <div className="text-lg font-semibold text-blue-900">🔄 Atualizando Ativos</div>
              <div className="text-sm text-blue-700">Sincronizando dados do BingX...</div>
              {refreshProgress.processed > 0 && refreshProgress.total > 0 && (
                <div className="text-xs text-blue-600 mt-1">
                  {refreshProgress.processed}/{refreshProgress.total} contratos processados
                </div>
              )}
            </div>
          </div>
        </div>
      )}


      {/* Statistics Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="card p-6">
            <h3 className="text-lg font-medium text-gray-900">Total Assets</h3>
            <p className="text-3xl font-bold text-gray-900">{stats.totalAssets}</p>
            <p className="text-sm text-gray-500">{stats.tradingAssets} trading</p>
          </div>
          
          <div className="card p-6">
            <h3 className="text-lg font-medium text-gray-900">Top Gainer</h3>
            {stats.topGainers && stats.topGainers.length > 0 ? (
              <>
                <p className="text-xl font-bold text-gray-900">{stats.topGainers[0].symbol}</p>
                <p className="text-lg font-bold text-green-600">
                  {formatPercent(stats.topGainers[0].priceChangePercent)}
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-500">
                {stats.totalAssets > 0 ? t('common.noData') : t('common.loading')}
              </p>
            )}
          </div>
          
          <div className="card p-6">
            <h3 className="text-lg font-medium text-gray-900">Highest Volume</h3>
            {stats.topVolume && stats.topVolume.length > 0 ? (
              <>
                <p className="text-xl font-bold text-gray-900">{stats.topVolume[0].symbol}</p>
                <p className="text-lg text-gray-600">
                  ${formatNumber(stats.topVolume[0].quoteVolume24h)}
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-500">
                {stats.totalAssets > 0 ? t('common.noData') : t('common.loading')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="card p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="label">Search</label>
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
              placeholder="Buscar por símbolo ou nome..."
              className="input"
            />
          </div>
          
          <div>
            <label className="label">Status</label>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value)
                setPage(1)
              }}
              className="input"
            >
              <option value="">All</option>
              <option value="TRADING">Trading</option>
              <option value="SUSPEND">Suspended</option>
            </select>
          </div>
          
          <div className="flex items-end">
            <span className="text-sm text-gray-500">
              {pagination?.total || 0} assets found
            </span>
          </div>
        </div>
      </div>

      {/* Assets Table */}
      <div className={`card overflow-hidden ${isRefreshing ? 'ring-2 ring-blue-200 bg-blue-50/30' : ''}`}>
        {isRefreshing && (
          <div className="bg-blue-100 border-b border-blue-200 px-6 py-2">
            <div className="flex items-center space-x-2 text-blue-800">
              <div className="w-3 h-3 border border-blue-400 border-t-blue-600 rounded-full animate-spin"></div>
              <span className="text-sm font-medium">Dados sendo atualizados em tempo real...</span>
            </div>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th 
                  onClick={() => handleSort('symbol')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Symbol {sortBy === 'symbol' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('name')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Name {sortBy === 'name' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('lastPrice')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Price {sortBy === 'lastPrice' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('priceChangePercent')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  24h Change {sortBy === 'priceChangePercent' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('quoteVolume24h')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Volume (24h) {sortBy === 'quoteVolume24h' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('maxLeverage')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Max Leverage {sortBy === 'maxLeverage' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th 
                  onClick={() => handleSort('updatedAt')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Last Update {sortBy === 'updatedAt' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="px-6 py-4 text-center text-gray-500">
                    Loading assets...
                  </td>
                </tr>
              ) : assets.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-4 text-center text-gray-500">
                    No assets found
                  </td>
                </tr>
              ) : (
                assets.map((asset: Asset) => (
                  <tr key={asset.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="font-medium text-gray-900">{asset.symbol}</div>
                      <div className="text-sm text-gray-500">{asset.baseCurrency}/{asset.quoteCurrency}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="font-medium text-gray-900">{asset.name}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      ${Number(asset.lastPrice).toFixed(4)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`text-sm font-medium ${
                        asset.priceChangePercent >= 0 ? 'text-green-600' : 'text-red-600'
                      }`}>
                        {formatPercent(asset.priceChangePercent)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      ${formatNumber(asset.quoteVolume24h)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {asset.maxLeverage}x
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                        asset.status === 'TRADING' 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {asset.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {formatDate(asset.updatedAt)}
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
              <div className="flex-1 flex justify-between sm:hidden">
                <button
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page === 1}
                  className="btn btn-secondary"
                >
                  {t('common.previous')}
                </button>
                <button
                  onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
                  disabled={page === pagination.totalPages}
                  className="btn btn-secondary"
                >
                  {t('common.next')}
                </button>
              </div>
              <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm text-gray-700">
                    Showing {((page - 1) * limit) + 1} to {Math.min(page * limit, pagination.total)} of{' '}
                    {pagination.total} results
                  </p>
                </div>
                <div>
                  <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px">
                    <button
                      onClick={() => setPage(Math.max(1, page - 1))}
                      disabled={page === 1}
                      className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                    >
                      {t('common.previous')}
                    </button>
                    
                    {/* Page numbers */}
                    {Array.from({ length: Math.min(5, pagination.totalPages) }, (_, i) => {
                      const pageNum = i + 1
                      return (
                        <button
                          key={pageNum}
                          onClick={() => setPage(pageNum)}
                          className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium ${
                            page === pageNum
                              ? 'z-10 bg-primary-50 border-primary-500 text-primary-600'
                              : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                          }`}
                        >
                          {pageNum}
                        </button>
                      )
                    })}
                    
                    <button
                      onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
                      disabled={page === pagination.totalPages}
                      className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                    >
                      {t('common.next')}
                    </button>
                  </nav>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}