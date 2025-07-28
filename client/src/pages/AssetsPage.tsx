import { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { api } from '../services/api'
import { toast } from 'react-hot-toast'
import type { Asset, PaginatedResponse } from '../types'
import { useTranslation } from '../hooks/useTranslation'

export default function AssetsPage() {
  const [page, setPage] = useState(1)
  const [limit] = useState(20)
  const [sortBy, setSortBy] = useState('quoteVolume24h')
  const [sortOrder, setSortOrder] = useState<'ASC' | 'DESC'>('DESC')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('TRADING')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [refreshProgress, setRefreshProgress] = useState({ 
    progress: 0, 
    message: '', 
    processed: 0, 
    total: 0, 
    executionTime: '', 
    performance: '' 
  })
  const [lastUpdateTime, setLastUpdateTime] = useState<string>('')
  const [statusBreakdown, setStatusBreakdown] = useState<any>(null)
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  // Get assets data with pagination
  const { data: assetsData, isLoading, refetch } = useQuery<PaginatedResponse<Asset>>(
    ['assets', page, limit, sortBy, sortOrder, search, status],
    () => api.getAssets({ page, limit, sortBy, sortOrder, search, status }),
    {
      keepPreviousData: true,
    }
  )
  console.log('Assets Data Debug:', { assetsData, isLoading, page, limit, sortBy, sortOrder, search, status })
  // Get asset statistics
  const { data: statsResponse } = useQuery('asset-stats', api.getAssetStats, {
    onSuccess: (data) => {
      console.log('Asset stats received:', data)
    }
  })
  
  const stats = (statsResponse as any)?.data || statsResponse


  const assets = (assetsData as any)?.data?.assets || []
  const pagination = (assetsData as any)?.data?.pagination

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
    
    // Loading inicial simples
    setRefreshProgress({ 
      progress: 0, 
      message: 'Iniciando atualização...', 
      processed: 0, 
      total: 0,
      executionTime: '',
      performance: ''
    })
    
    toast.loading('Atualizando ativos da BingX...', { id: 'refresh-assets' })
    
    try {
      await api.refreshAssets((progressData) => {
        console.log('📊 Progress recebido:', progressData)
        
        // Update progress state com animação suave
        setRefreshProgress({
          progress: progressData.progress || 0,
          message: progressData.message || '',
          processed: progressData.processed || 0,
          total: progressData.total || 0,
          executionTime: progressData.executionTime || '',
          performance: progressData.performance || '',
          current: progressData.current || ''
        })
        
        // Update toast with progress
        if (progressData.type === 'progress') {
          const emoji = progressData.progress < 30 ? '🔄' : 
                        progressData.progress < 60 ? '⚡' : 
                        progressData.progress < 90 ? '🚀' : '🏁'
          
          toast.loading(
            `${emoji} ${progressData.message || 'Processando...'}\n📊 Progresso: ${progressData.progress || 0}%`,
            { id: 'refresh-assets' }
          )
        } else if (progressData.type === 'completed') {
          const performancePart = progressData.executionTime ? 
            `\nConcluído em ${progressData.executionTime} (${progressData.performance || ''})` : '';
          
          const statusPart = progressData.statusDistribution ? 
            `\n📊 Status: ${progressData.statusDistribution.TRADING || 0} ativos, ${progressData.statusDistribution.SUSPENDED || 0} suspensos, ${progressData.statusDistribution.DELISTED || 0} removidos` : '';
          
          toast.success(
            `Todos os contratos sincronizados!\n${progressData.created || 0} criados, ${progressData.updated || 0} atualizados\n${progressData.processed || 0} contratos processados de ${progressData.total || 0} totais${statusPart}${performancePart}`,
            { 
              id: 'refresh-assets',
              duration: 10000 
            }
          )
          
          // Update last update time and status breakdown
          setLastUpdateTime(new Date().toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }))
          
          // Store status breakdown for display
          if (progressData.statusDistribution) {
            setStatusBreakdown(progressData.statusDistribution)
          }
          
          // Invalidate and refetch all related queries after completion
          queryClient.invalidateQueries(['assets'])
          queryClient.invalidateQueries(['all-assets'])
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
      setRefreshProgress({ 
        progress: 0, 
        message: '', 
        processed: 0, 
        total: 0, 
        executionTime: '', 
        performance: '' 
      })
      
      // Ensure cache invalidation happens even on error for consistency
      queryClient.invalidateQueries(['assets'])
      queryClient.invalidateQueries(['all-assets'])
      queryClient.invalidateQueries('asset-stats')
    }
  }

  // Handle clear database
  const handleClearDatabase = async () => {
    console.log('🎯 CLICK: Botão limpar banco clicado')
    
    const confirmed = window.confirm(
      '⚠️ ATENÇÃO!\n\nEsta ação irá REMOVER TODOS OS ATIVOS do banco de dados.\n\nVocê tem certeza que deseja continuar?\n\nClique OK para confirmar ou Cancelar para abortar.'
    )
    
    console.log('🎯 CONFIRMAÇÃO 1:', confirmed)
    if (!confirmed) {
      console.log('❌ Usuário cancelou na primeira confirmação')
      return
    }
    
    const doubleConfirm = window.confirm(
      '🚨 CONFIRMAÇÃO FINAL\n\nEsta é sua última chance!\n\nTodos os dados de ativos serão PERMANENTEMENTE REMOVIDOS.\n\nTem ABSOLUTA CERTEZA?'
    )
    
    console.log('🎯 CONFIRMAÇÃO 2:', doubleConfirm)
    if (!doubleConfirm) {
      console.log('❌ Usuário cancelou na segunda confirmação')
      return
    }

    console.log('✅ Usuário confirmou ambas as confirmações, prosseguindo...')
    
    setIsClearing(true)
    console.log('🔄 Estado isClearing definido como true')
    
    toast.loading('🗑️ Removendo todos os ativos do banco de dados...', { id: 'clear-assets' })
    console.log('📱 Toast de loading mostrado')
    
    try {
      console.log('🔄 Iniciando chamada para api.clearAllAssets()...')
      const result = await api.clearAllAssets()
      console.log('✅ Resultado da API clearAllAssets:', result)
      
      const deletedCount = result?.deletedCount || 0
      console.log('📊 Quantidade de ativos removidos:', deletedCount)
      
      toast.success(
        `🎉 Banco de dados limpo com sucesso!\n${deletedCount} ativos removidos`,
        { 
          id: 'clear-assets',
          duration: 5000 
        }
      )
      console.log('📱 Toast de sucesso mostrado')
      
      // Update UI state to reflect empty database
      console.log('🔄 Atualizando estado da UI...')
      setLastUpdateTime('')
      setStatusBreakdown(null)
      
      // Invalidate and refetch all queries to show empty state
      console.log('🔄 Invalidando cache do React Query...')
      await queryClient.invalidateQueries(['assets'])
      await queryClient.invalidateQueries(['all-assets'])
      await queryClient.invalidateQueries('asset-stats')
      
      // Force a refetch to show empty data immediately
      console.log('🔄 Forçando refetch dos dados...')
      await refetch()
      console.log('✅ Refetch completo')
      
    } catch (error: any) {
      console.error('❌ ERRO COMPLETO na limpeza do banco:', {
        error,
        message: error?.message,
        response: error?.response,
        responseData: error?.response?.data,
        stack: error?.stack
      })
      
      const errorMessage = error?.message || error?.response?.data?.message || 'Falha ao limpar banco de dados'
      console.error('📱 Mostrando toast de erro:', errorMessage)
      
      toast.error(`❌ ${errorMessage}`, { id: 'clear-assets', duration: 8000 })
    } finally {
      console.log('🔄 Definindo isClearing como false no finally')
      setIsClearing(false)
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
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Asset Analysis</h1>
          {lastUpdateTime && (
            <p className="text-sm text-gray-600 mt-1">
              🕒 Última atualização: <span className="font-medium text-blue-600">{lastUpdateTime}</span> (UTC-3)
            </p>
          )}
        </div>
        <div className="flex gap-3">
          <button
            onClick={(e) => {
              console.log('🎯 EVENTO CLICK CAPTURADO:', e)
              console.log('🎯 isClearing:', isClearing)
              console.log('🎯 isRefreshing:', isRefreshing)
              handleClearDatabase()
            }}
            disabled={isClearing || isRefreshing}
            className={`btn flex items-center gap-2 px-4 py-3 rounded-lg font-medium transition-all ${
              isClearing || isRefreshing
                ? 'bg-red-100 text-red-700 border border-red-300 cursor-not-allowed' 
                : 'bg-red-600 text-white hover:bg-red-700 border border-red-600'
            }`}
          >
            {isClearing ? (
              <>
                <div className="w-4 h-4 border-2 border-red-300 border-t-red-600 rounded-full animate-spin"></div>
                <span>🗑️ Limpando...</span>
              </>
            ) : (
              <>
                <span>🗑️</span>
                <span>Limpar DB</span>
              </>
            )}
          </button>
          
          <button
            onClick={handleRefresh}
            disabled={isRefreshing || isClearing}
            className={`btn flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-all ${
              isRefreshing || isClearing
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
      </div>

      {/* Scan Status */}
      {isRefreshing && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-6">
          <div className="space-y-4">
            <div className="flex items-center justify-center space-x-3">
              <div className="relative">
                <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
                <div className="absolute inset-0 w-8 h-8 border-4 border-transparent border-t-blue-400 rounded-full animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }}></div>
              </div>
              <div className="text-center">
                <div className="text-lg font-semibold text-blue-900">🚀 Buscando TODOS os Contratos da BingX</div>
                <div className="text-sm text-blue-700">
                  {refreshProgress.total > 0 
                    ? `Processando ${refreshProgress.total} contratos encontrados...`
                    : 'Descobrindo todos os contratos disponíveis na BingX...'
                  }
                </div>
              </div>
            </div>
            
            {/* Enhanced Progress Bar */}
            <div className="w-full">
              <div className="flex justify-between text-sm text-blue-700 mb-2">
                <span className="font-medium">
                  {refreshProgress.message || 'Inicializando busca...'}
                </span>
                <span className="font-bold">
                  {refreshProgress.progress || 0}%
                </span>
              </div>
              
              <div className="w-full bg-blue-200 rounded-full h-4 relative overflow-hidden">
                <div 
                  className="bg-gradient-to-r from-blue-500 to-blue-600 h-4 rounded-full transition-all duration-500 ease-out relative"
                  style={{ width: `${refreshProgress.progress || 0}%` }}
                >
                  {/* Animated shine effect */}
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white to-transparent opacity-20 animate-pulse"></div>
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-blue-600 mt-3">
                <div className="text-center">
                  <div className="font-semibold text-blue-800">📊 Progresso</div>
                  <div className="font-mono">
                    {refreshProgress.processed || 0}/{refreshProgress.total || '?'} contratos
                  </div>
                </div>
                
                {refreshProgress.performance && (
                  <div className="text-center">
                    <div className="font-semibold text-green-700">⚡ Performance</div>
                    <div className="font-mono text-green-600">
                      {refreshProgress.performance} contratos/seg
                    </div>
                  </div>
                )}
                
                {refreshProgress.executionTime && (
                  <div className="text-center">
                    <div className="font-semibold text-purple-700">⏱️ Tempo</div>
                    <div className="font-mono text-purple-600">
                      {refreshProgress.executionTime}s
                    </div>
                  </div>
                )}
              </div>
              
              {/* Current contract being processed */}
              {refreshProgress.current && (
                <div className="mt-2 text-center">
                  <div className="text-xs text-blue-500">
                    Processando: <span className="font-mono font-medium text-blue-700">{refreshProgress.current}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}


      {/* Contract Status Breakdown */}
      {statusBreakdown && (
        <div className="card p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">📊 Distribuição de Status dos Contratos</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{statusBreakdown.TRADING || 0}</div>
              <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                <span>🟢</span>
                <span>Trading</span>
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-yellow-600">{statusBreakdown.SUSPENDED || 0}</div>
              <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                <span>🟡</span>
                <span>Suspended</span>
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">{statusBreakdown.DELISTED || 0}</div>
              <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                <span>🔴</span>
                <span>Delisted</span>
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">{statusBreakdown.MAINTENANCE || 0}</div>
              <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                <span>🔵</span>
                <span>Maintenance</span>
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-gray-600">{statusBreakdown.UNKNOWN || 0}</div>
              <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                <span>⚪</span>
                <span>Unknown</span>
              </div>
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
              <option value="">🔍 Todos os Status</option>
              <option value="TRADING">🟢 Trading (Ativos)</option>
              <option value="SUSPENDED">🟡 Suspended (Suspensos)</option>
              <option value="DELISTED">🔴 Delisted (Removidos)</option>
              <option value="MAINTENANCE">🔵 Maintenance (Manutenção)</option>
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
          <div className="bg-gradient-to-r from-blue-100 to-blue-50 border-b border-blue-200 px-6 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2 text-blue-800">
                <div className="w-3 h-3 border border-blue-400 border-t-blue-600 rounded-full animate-spin"></div>
                <span className="text-sm font-medium">Base de dados sendo sincronizada...</span>
              </div>
              {refreshProgress.total > 0 && (
                <div className="text-xs text-blue-700">
                  {refreshProgress.processed}/{refreshProgress.total} ({refreshProgress.progress || 0}%)
                </div>
              )}
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
                  onClick={() => handleSort('highPrice24h')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  High 24h {sortBy === 'highPrice24h' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('lowPrice24h')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Low 24h {sortBy === 'lowPrice24h' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('openInterest')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Open Interest {sortBy === 'openInterest' && (sortOrder === 'ASC' ? '↑' : '↓')}
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
                  <td colSpan={11} className="px-6 py-4 text-center text-gray-500">
                    Loading assets...
                  </td>
                </tr>
              ) : assets.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-6 py-4 text-center text-gray-500">
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
                      ${Number(asset.highPrice24h).toFixed(4)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      ${Number(asset.lowPrice24h).toFixed(4)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {formatNumber(asset.openInterest)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {asset.maxLeverage}x
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full ${
                        asset.status === 'TRADING' 
                          ? 'bg-green-100 text-green-800' 
                          : asset.status === 'SUSPENDED'
                          ? 'bg-yellow-100 text-yellow-800'
                          : asset.status === 'DELISTED'
                          ? 'bg-red-100 text-red-800'
                          : asset.status === 'MAINTENANCE'
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}>
                        {asset.status === 'TRADING' ? '🟢' : 
                         asset.status === 'SUSPENDED' ? '🟡' : 
                         asset.status === 'DELISTED' ? '🔴' : 
                         asset.status === 'MAINTENANCE' ? '🔵' : 
                         '⚪'} {asset.status}
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