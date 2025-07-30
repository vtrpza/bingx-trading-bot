import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { api, apiUtils } from '../services/api'
import { toast } from 'react-hot-toast'
import type { Asset, PaginatedResponse } from '../types'

// Simple debounce utility function
function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
) {
  let timeout: ReturnType<typeof setTimeout>
  const debounced = (...args: Parameters<T>) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => func(...args), wait)
  }
  debounced.cancel = () => clearTimeout(timeout)
  return debounced
}

// Memoized table row component for performance
const AssetRow = React.memo(({ 
  asset, 
  formatPercent, 
  formatNumber, 
  formatDate 
}: {
  asset: Asset
  formatPercent: (value: number | string) => string
  formatNumber: (value: number | string, decimals?: number) => string
  formatDate: (dateString: string) => string
}) => (
  <tr className="hover:bg-gray-50">
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
          : asset.status === 'INVALID'
          ? 'bg-purple-100 text-purple-800'
          : 'bg-gray-100 text-gray-800'
      }`}>
        {asset.status === 'TRADING' ? '🟢 Negociando' : 
         asset.status === 'SUSPENDED' ? '🟡 Suspenso' : 
         asset.status === 'DELISTED' ? '🔴 Removido' : 
         asset.status === 'MAINTENANCE' ? '🔵 Manutenção' : 
         asset.status === 'INVALID' ? '🟣 Inválido' : 
         '⚪ Desconhecido'}
      </span>
    </td>
    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
      {formatDate(asset.updatedAt)}
    </td>
  </tr>
), (prevProps, nextProps) => {
  // Custom comparison for better performance
  return (
    prevProps.asset.id === nextProps.asset.id &&
    prevProps.asset.lastPrice === nextProps.asset.lastPrice &&
    prevProps.asset.priceChangePercent === nextProps.asset.priceChangePercent &&
    prevProps.asset.status === nextProps.asset.status &&
    prevProps.asset.updatedAt === nextProps.asset.updatedAt
  )
})

export default function AssetsPage() {
  const [page, setPage] = useState(1)
  const [limit] = useState(20)
  const [sortBy, setSortBy] = useState('quoteVolume24h')
  const [sortOrder, setSortOrder] = useState<'ASC' | 'DESC'>('DESC')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [status, setStatus] = useState('TRADING')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [refreshProgress, setRefreshProgress] = useState({ 
    progress: 0, 
    message: '', 
    processed: 0, 
    total: 0, 
    executionTime: '', 
    performance: '',
    current: ''
  })
  const [lastUpdateTime, setLastUpdateTime] = useState<string>('')
  const [statusBreakdown, setStatusBreakdown] = useState<any>(null)
  
  const queryClient = useQueryClient()
  const toastIdRef = useRef<string>('')
  const refreshAbortController = useRef<AbortController | null>(null)

  // Debounced search handler
  const debouncedSearchHandler = useMemo(
    () => debounce((value: string) => {
      setDebouncedSearch(value)
      setPage(1)
    }, 300),
    []
  )

  useEffect(() => {
    debouncedSearchHandler(search)
    return () => {
      debouncedSearchHandler.cancel()
    }
  }, [search, debouncedSearchHandler])

  // 🎯 CACHE FIX: Auto-detect cache issues on page load
  useEffect(() => {
    const checkCacheHealth = () => {
      try {
        const diagnosis = apiUtils.diagnoseCacheHealth()
        
        if (diagnosis.recommendations.length > 0) {
          console.warn('⚠️ Cache health issues detected:', diagnosis)
          
          // Show warning if cache issues are detected
          if (diagnosis.requestCacheSize > 30 || diagnosis.localStorageKeys > 15) {
            toast(
              '⚠️ Cache pode estar corrompido. Se você estiver tendo problemas com refresh, ' +
              'tente usar o botão "Limpar Cache" para resolver.',
              {
                id: 'cache-warning',
                duration: 8000,
                icon: '🧹'
              }
            )
          }
        }
      } catch (error) {
        console.error('Error checking cache health:', error)
      }
    }
    
    // Check cache health after component mounts
    setTimeout(checkCacheHealth, 2000)
  }, [])

  // Optimized query key factory
  const queryKeys = useMemo(() => ({
    assets: ['assets', page, limit, sortBy, sortOrder, debouncedSearch, status] as const,
    stats: ['asset-stats'] as const,
    allAssets: ['all-assets'] as const
  }), [page, limit, sortBy, sortOrder, debouncedSearch, status])

  // Get assets data with pagination - optimized with debounced search
  const { data: assetsData, isLoading, refetch } = useQuery<PaginatedResponse<Asset>>(
    queryKeys.assets,
    () => api.getAssets({ 
      page, 
      limit, 
      sortBy, 
      sortOrder, 
      search: debouncedSearch, 
      status 
    }),
    {
      keepPreviousData: true,
      staleTime: 30 * 1000, // Consider data fresh for 30 seconds
      cacheTime: 5 * 60 * 1000, // Keep in cache for 5 minutes
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always'
    }
  )
  
  // Get asset statistics with proper caching
  const { data: statsResponse } = useQuery(
    queryKeys.stats, 
    api.getAssetStats, 
    {
      staleTime: 60 * 1000, // Stats are fresh for 1 minute
      cacheTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
      refetchOnWindowFocus: false
    }
  )
  
  const stats = (statsResponse as any)?.data || statsResponse


  const assets = (assetsData as any)?.data?.assets || []
  const pagination = (assetsData as any)?.data?.pagination

  // Memoized formatters
  const formatNumber = useCallback((value: number | string, decimals = 2) => {
    const numValue = Number(value)
    if (numValue >= 1e9) return (numValue / 1e9).toFixed(1) + 'B'
    if (numValue >= 1e6) return (numValue / 1e6).toFixed(1) + 'M'
    if (numValue >= 1e3) return (numValue / 1e3).toFixed(1) + 'K'
    return numValue.toFixed(decimals)
  }, [])

  const formatPercent = useCallback((value: number | string) => {
    const numValue = Number(value)
    const formatted = numValue.toFixed(1)
    return numValue >= 0 ? `+${formatted}%` : `${formatted}%`
  }, [])

  const formatDate = useCallback((dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }, [])

  // Optimized sort handler
  const handleSort = useCallback((column: string) => {
    if (sortBy === column) {
      setSortOrder(prev => prev === 'ASC' ? 'DESC' : 'ASC')
    } else {
      setSortBy(column)
      setSortOrder('DESC')
    }
    setPage(1)
  }, [sortBy])

  // Optimized smart refresh with abort controller
  const handleSmartRefresh = useCallback(async () => {
    // Cancel any ongoing refresh
    if (refreshAbortController.current) {
      refreshAbortController.current.abort()
    }
    
    refreshAbortController.current = new AbortController()
    const signal = refreshAbortController.current.signal
    
    setIsRefreshing(true)
    setRefreshProgress({ 
      progress: 0, 
      message: 'Iniciando atualização inteligente...', 
      processed: 0, 
      total: 0,
      executionTime: '',
      performance: '',
      current: ''
    })
    
    toastIdRef.current = 'smart-refresh-assets'
    toast.loading('🧠 Atualização inteligente em progresso...', { id: toastIdRef.current })
    
    try {
      await api.refreshAssetsDelta((progressData) => {
        if (signal.aborted) return
        
        setRefreshProgress(progressData)
        
        if (progressData.type === 'progress') {
          const emoji = progressData.progress < 30 ? '🧠' : 
                        progressData.progress < 60 ? '⚡' : 
                        progressData.progress < 90 ? '🚀' : '🏁'
          
          toast.loading(
            `${emoji} ${progressData.message || 'Processando inteligente...'}\\n📊 Progresso: ${progressData.progress || 0}%`,
            { id: toastIdRef.current }
          )
        } else if (progressData.type === 'completed') {
          const deltaMode = progressData.deltaMode || 'FULL_REFRESH'
          const modeText = deltaMode === 'MARKET_DATA_ONLY' ? 'Preços atualizados' : 'Refresh completo'
          const performancePart = progressData.executionTime ? 
            `\\n⚡ ${modeText} em ${progressData.executionTime}s` : ''
          
          toast.success(
            `🎉 Atualização inteligente concluída!\\n${progressData.created || 0} criados, ${progressData.updated || 0} atualizados${performancePart}`,
            { 
              id: toastIdRef.current,
              duration: 8000 
            }
          )
          
          setLastUpdateTime(new Date().toLocaleString('pt-BR', {
            timeZone: 'America/Sao_Paulo',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }))
          
          // Batch invalidate queries
          queryClient.invalidateQueries({ 
            predicate: (query) => {
              const key = query.queryKey[0]
              return key === 'assets' || key === 'all-assets' || key === 'asset-stats'
            }
          })
        } else if (progressData.type === 'error') {
          toast.error(progressData.message || 'Erro durante a atualização inteligente', { id: toastIdRef.current })
        }
      })
      
      if (!signal.aborted) {
        await refetch()
      }
      
    } catch (error: any) {
      if (!signal.aborted) {
        const errorMessage = error instanceof Error ? error.message : 'Falha na atualização inteligente'
        toast.error(errorMessage, { id: toastIdRef.current })
      }
    } finally {
      if (!signal.aborted) {
        setIsRefreshing(false)
        setRefreshProgress({ 
          progress: 0, 
          message: '', 
          processed: 0, 
          total: 0, 
          executionTime: '', 
          performance: '',
          current: ''
        })
      }
      refreshAbortController.current = null
    }
  }, [queryClient, refetch])

  // Handle full refresh (legacy)
  const handleRefresh = async () => {
    setIsRefreshing(true)
    
    // Loading inicial simples
    setRefreshProgress({ 
      progress: 0, 
      message: 'Iniciando atualização...', 
      processed: 0, 
      total: 0,
      executionTime: '',
      performance: '',
      current: ''
    })
    
    toast.loading('Atualizando ativos da BingX...', { id: 'refresh-assets' })
    
    try {
      await api.refreshAssets((progressData) => {
        
        // Update progress state com animação suave
        setRefreshProgress({
          progress: progressData.progress || 0,
          message: progressData.message || '',
          processed: progressData.processed || 0,
          total: progressData.total || 0,
          executionTime: progressData.executionTime || '',
          performance: typeof progressData.performance === 'string' 
            ? progressData.performance 
            : typeof progressData.performance === 'object' && (progressData.performance as any).assetsPerSecond
              ? (progressData.performance as any).assetsPerSecond
              : '',
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
            `\nConcluído em ${progressData.executionTime} (${
              typeof progressData.performance === 'string' 
                ? progressData.performance 
                : typeof progressData.performance === 'object' && (progressData.performance as any).assetsPerSecond
                  ? (progressData.performance as any).assetsPerSecond
                  : ''
            })` : '';
          
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
        performance: '',
        current: ''
      })
      
      // Ensure cache invalidation happens even on error for consistency
      queryClient.invalidateQueries(['assets'])
      queryClient.invalidateQueries(['all-assets'])
      queryClient.invalidateQueries('asset-stats')
    }
  }


  // 🎯 CACHE FIX: Clear frontend caches handler
  const handleClearCache = useCallback(async () => {
    const confirmed = window.confirm(
      '🧹 LIMPAR CACHE DO FRONTEND\n\n' +
      'Esta ação irá limpar todos os caches do navegador (localStorage, sessionStorage, etc.) ' +
      'e recarregar a página para garantir estado limpo.\n\n' +
      'Isso pode resolver problemas de cache corrompido.\n\n' +
      'Continuar?'
    )
    
    if (!confirmed) return
    
    toast.loading('🧹 Limpando todos os caches...', { id: 'clear-cache' })
    
    try {
      // Diagnose cache health first
      const diagnosis = apiUtils.diagnoseCacheHealth()
      console.log('📊 Cache diagnosis:', diagnosis)
      
      if (diagnosis.recommendations.length > 0) {
        console.log('💡 Cache recommendations:', diagnosis.recommendations)
      }
      
      // Clear all caches
      apiUtils.clearAllCaches()
      
      toast.success(
        `✅ Cache limpo com sucesso!\n` +
        `🗑️ ${diagnosis.requestCacheSize} requests em cache\n` +
        `📦 ${diagnosis.localStorageKeys} itens localStorage\n` +
        `🔄 Recarregando página...`,
        { 
          id: 'clear-cache',
          duration: 3000 
        }
      )
      
      // Force reload after showing success message
      setTimeout(() => {
        apiUtils.forceReload()
      }, 1000)
      
    } catch (error: any) {
      const errorMessage = error?.message || 'Falha ao limpar cache'
      toast.error(`❌ ${errorMessage}`, { id: 'clear-cache', duration: 8000 })
    }
  }, [])

  // Optimized clear database handler
  const handleClearDatabase = useCallback(async () => {
    const confirmed = window.confirm(
      '⚠️ ATENÇÃO!\n\nEsta ação irá REMOVER TODOS OS ATIVOS do banco de dados.\n\nVocê tem certeza que deseja continuar?\n\nClique OK para confirmar ou Cancelar para abortar.'
    )
    
    if (!confirmed) return
    
    const doubleConfirm = window.confirm(
      '🚨 CONFIRMAÇÃO FINAL\n\nEsta é sua última chance!\n\nTodos os dados de ativos serão PERMANENTEMENTE REMOVIDOS.\n\nTem ABSOLUTA CERTEZA?'
    )
    
    if (!doubleConfirm) return
    
    setIsClearing(true)
    
    toast.loading('🗑️ Removendo todos os ativos do banco de dados...', { id: 'clear-assets' })
    
    try {
      const result = await api.clearAllAssets()
      const deletedCount = result?.deletedCount || 0
      
      toast.success(
        `🎉 Banco de dados limpo com sucesso!\n${deletedCount} ativos removidos`,
        { 
          id: 'clear-assets',
          duration: 5000 
        }
      )
      
      setLastUpdateTime('')
      setStatusBreakdown(null)
      
      // Batch invalidate all asset queries
      queryClient.invalidateQueries({ 
        predicate: (query) => {
          const key = query.queryKey[0]
          return key === 'assets' || key === 'all-assets' || key === 'asset-stats'
        }
      })
      
    } catch (error: any) {
      const errorMessage = error?.message || error?.response?.data?.message || 'Falha ao limpar banco de dados'
      toast.error(`❌ ${errorMessage}`, { id: 'clear-assets', duration: 8000 })
    } finally {
      setIsClearing(false)
    }
  }, [queryClient])

  // Memoized progress bar component for better performance
  const ProgressBar = useMemo(() => {
    if (!isRefreshing) return null
    
    return (
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-6">
        <div className="space-y-4">
          <div className="flex items-center justify-center space-x-3">
            <div className="relative">
              <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin"></div>
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
                className="bg-gradient-to-r from-blue-500 to-blue-600 h-4 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${refreshProgress.progress || 0}%` }}
              />
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
                    {typeof refreshProgress.performance === 'string' 
                      ? refreshProgress.performance 
                      : typeof refreshProgress.performance === 'object' && (refreshProgress.performance as any).assetsPerSecond
                        ? (refreshProgress.performance as any).assetsPerSecond
                        : 'Calculando...'
                    }
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
    )
  }, [isRefreshing, refreshProgress])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Análise de Ativos</h1>
          {lastUpdateTime && (
            <p className="text-sm text-gray-600 mt-1">
              🕒 Última atualização: <span className="font-medium text-blue-600">{lastUpdateTime}</span> (UTC-3)
            </p>
          )}
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleClearCache}
            disabled={isRefreshing || isClearing}
            className={`btn flex items-center gap-2 px-4 py-3 rounded-lg font-medium transition-all ${
              isRefreshing || isClearing
                ? 'bg-orange-100 text-orange-700 border border-orange-300 cursor-not-allowed' 
                : 'bg-orange-600 text-white hover:bg-orange-700 border border-orange-600'
            }`}
            title="Limpa todos os caches do frontend para resolver problemas de dados corrompidos"
          >
            <span>🧹</span>
            <span>Limpar Cache</span>
          </button>
          
          <button
            onClick={handleClearDatabase}
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
            onClick={handleSmartRefresh}
            disabled={isRefreshing || isClearing}
            className={`btn flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-all ${
              isRefreshing || isClearing
                ? 'bg-green-100 text-green-700 border border-green-300 cursor-not-allowed' 
                : 'bg-green-600 text-white hover:bg-green-700 border border-green-600'
            }`}
          >
            {isRefreshing ? (
              <>
                <div className="w-4 h-4 border-2 border-green-300 border-t-green-600 rounded-full animate-spin"></div>
                <span>🧠 Atualizando...</span>
              </>
            ) : (
              <>
                <span>🧠</span>
                <span>Atualização Inteligente</span>
              </>
            )}
          </button>
          
          <button
            onClick={handleRefresh}
            disabled={isRefreshing || isClearing}
            className={`btn flex items-center gap-2 px-4 py-3 rounded-lg font-medium transition-all ${
              isRefreshing || isClearing
                ? 'bg-blue-100 text-blue-700 border border-blue-300 cursor-not-allowed' 
                : 'bg-blue-600 text-white hover:bg-blue-700 border border-blue-600'
            }`}
          >
            {isRefreshing ? (
              <>
                <div className="w-4 h-4 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin"></div>
                <span>🔄 Completo...</span>
              </>
            ) : (
              <>
                <span>🔄</span>
                <span>Refresh Completo</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Progress Bar - Memoized for Performance */}
      {ProgressBar}


      {/* Contract Status Breakdown */}
      {statusBreakdown && (
        <div className="card p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">📊 Distribuição de Status dos Contratos</h3>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{statusBreakdown.TRADING || 0}</div>
              <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                <span>🟢</span>
                <span>Negociando</span>
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-yellow-600">{statusBreakdown.SUSPENDED || 0}</div>
              <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                <span>🟡</span>
                <span>Suspenso</span>
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">{statusBreakdown.DELISTED || 0}</div>
              <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                <span>🔴</span>
                <span>Removido</span>
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">{statusBreakdown.MAINTENANCE || 0}</div>
              <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                <span>🔵</span>
                <span>Manutenção</span>
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-600">{statusBreakdown.INVALID || 0}</div>
              <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                <span>🟣</span>
                <span>Inválido</span>
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-gray-600">{statusBreakdown.UNKNOWN || 0}</div>
              <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                <span>⚪</span>
                <span>Desconhecido</span>
              </div>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-gray-200">
            <div className="text-center">
              <div className="text-xl font-bold text-gray-800">
                {Object.values(statusBreakdown).reduce((total: number, count: any) => total + (count || 0), 0)}
              </div>
              <div className="text-sm text-gray-600">Total de Ativos</div>
            </div>
          </div>
        </div>
      )}

      {/* Statistics Cards */}
      {stats && (
        <div className="grid grid-cols-1 gap-6">
          <div className="card p-6">
            <h3 className="text-lg font-medium text-gray-900">Total de Ativos</h3>
            <p className="text-3xl font-bold text-gray-900">{stats.totalAssets}</p>
            <p className="text-sm text-gray-500">{stats.tradingAssets} em negociação</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="card p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="label">Buscar</label>
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
              <option value="TRADING">🟢 Negociando</option>
              <option value="SUSPENDED">🟡 Suspenso</option>
              <option value="DELISTED">🔴 Removido</option>
              <option value="MAINTENANCE">🔵 Manutenção</option>
              <option value="INVALID">🟣 Inválido</option>
              <option value="UNKNOWN">⚪ Desconhecido</option>
            </select>
          </div>
          
          <div className="flex items-end">
            <span className="text-sm text-gray-500">
              {pagination?.total || 0} ativos encontrados
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
                  Símbolo {sortBy === 'symbol' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('name')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Nome {sortBy === 'name' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('lastPrice')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Preço {sortBy === 'lastPrice' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('priceChangePercent')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Variação 24h {sortBy === 'priceChangePercent' && (sortOrder === 'ASC' ? '↑' : '↓')}
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
                  Máxima 24h {sortBy === 'highPrice24h' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('lowPrice24h')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Mínima 24h {sortBy === 'lowPrice24h' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('maxLeverage')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Alavancagem Máx {sortBy === 'maxLeverage' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('status')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Status {sortBy === 'status' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
                <th 
                  onClick={() => handleSort('updatedAt')}
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                >
                  Última Atualização {sortBy === 'updatedAt' && (sortOrder === 'ASC' ? '↑' : '↓')}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {isLoading ? (
                <tr>
                  <td colSpan={10} className="px-6 py-4 text-center text-gray-500">
                    Carregando ativos...
                  </td>
                </tr>
              ) : assets.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-6 py-4 text-center text-gray-500">
                    Nenhum ativo encontrado
                  </td>
                </tr>
              ) : (
                assets.map((asset: Asset) => (
                  <AssetRow 
                    key={asset.id}
                    asset={asset}
                    formatPercent={formatPercent}
                    formatNumber={formatNumber}
                    formatDate={formatDate}
                  />
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
                  Anterior
                </button>
                <button
                  onClick={() => setPage(Math.min(pagination.totalPages, page + 1))}
                  disabled={page === pagination.totalPages}
                  className="btn btn-secondary"
                >
                  Próximo
                </button>
              </div>
              <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm text-gray-700">
                    Mostrando {((page - 1) * limit) + 1} a {Math.min(page * limit, pagination.total)} de{' '}
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
                      Próximo
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