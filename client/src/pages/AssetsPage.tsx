import { useState } from 'react'
import { useQuery } from 'react-query'
import { api } from '../services/api'
import { toast } from 'react-hot-toast'
import type { Asset } from '../types'

export default function AssetsPage() {
  const [page, setPage] = useState(1)
  const [limit] = useState(20)
  const [sortBy, setSortBy] = useState('quoteVolume24h')
  const [sortOrder, setSortOrder] = useState<'ASC' | 'DESC'>('DESC')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('TRADING')
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Get assets data
  const { data: assetsData, isLoading, refetch } = useQuery(
    ['assets', page, limit, sortBy, sortOrder, search, status],
    () => api.getAssets({ page, limit, sortBy, sortOrder, search, status }),
    {
      keepPreviousData: true,
    }
  )

  // Get asset statistics
  const { data: stats } = useQuery('asset-stats', api.getAssetStats)

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
    toast.loading('Refreshing assets from BingX...', { id: 'refresh-assets' })
    
    try {
      const result = await api.refreshAssets()
      const { created = 0, updated = 0, total = 0, processed = 0, skipped = 0 } = result || {}
      
      toast.success(
        `Assets refreshed successfully!\n${created} created, ${updated} updated\n${processed} processed, ${skipped} skipped from ${total} total contracts`,
        { 
          id: 'refresh-assets',
          duration: 5000
        }
      )
      refetch()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to refresh assets'
      toast.error(errorMessage, { id: 'refresh-assets' })
    } finally {
      setIsRefreshing(false)
    }
  }

  // Format number
  const formatNumber = (value: number, decimals = 2) => {
    if (value >= 1e9) return (value / 1e9).toFixed(1) + 'B'
    if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M'
    if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K'
    return value.toFixed(decimals)
  }

  // Format percentage
  const formatPercent = (value: number) => {
    const formatted = value.toFixed(2)
    return value >= 0 ? `+${formatted}%` : `${formatted}%`
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Asset Analysis</h1>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className={`btn btn-primary flex items-center gap-2 ${isRefreshing ? 'opacity-75 cursor-not-allowed' : ''}`}
        >
          {isRefreshing && (
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
            </svg>
          )}
          {isRefreshing ? 'Refreshing from BingX...' : 'Refresh Data'}
        </button>
      </div>

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
            {stats.topGainers && stats.topGainers.length > 0 && stats.topGainers[0] && (
              <>
                <p className="text-xl font-bold text-gray-900">{stats.topGainers[0].symbol}</p>
                <p className="text-lg font-bold text-green-600">
                  {formatPercent(stats.topGainers[0].priceChangePercent)}
                </p>
              </>
            )}
            {(!stats.topGainers || stats.topGainers.length === 0) && (
              <p className="text-sm text-gray-500">No data available</p>
            )}
          </div>
          
          <div className="card p-6">
            <h3 className="text-lg font-medium text-gray-900">Highest Volume</h3>
            {stats.topVolume && stats.topVolume.length > 0 && stats.topVolume[0] && (
              <>
                <p className="text-xl font-bold text-gray-900">{stats.topVolume[0].symbol}</p>
                <p className="text-lg text-gray-600">
                  ${formatNumber(stats.topVolume[0].quoteVolume24h)}
                </p>
              </>
            )}
            {(!stats.topVolume || stats.topVolume.length === 0) && (
              <p className="text-sm text-gray-500">No data available</p>
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
              placeholder="Search by symbol or name..."
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
      <div className="card overflow-hidden">
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
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-4 text-center text-gray-500">
                    Loading assets...
                  </td>
                </tr>
              ) : assets.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-4 text-center text-gray-500">
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
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      ${asset.lastPrice.toFixed(4)}
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
                  Previous
                </button>
                <button
                  onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
                  disabled={page === pagination.totalPages}
                  className="btn btn-secondary"
                >
                  Next
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
                      Previous
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
                      Next
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