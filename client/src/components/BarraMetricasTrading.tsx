import { useQuery } from 'react-query'
import { api } from '../services/api'

interface TradingMetrics {
  winRate: number
  totalPnL: number
  dailyPnL: number
  activePositions: number
  totalTrades: number
  signalSuccessRate: number
  avgExecutionTime: number
  apiRateLimit: {
    used: number
    total: number
    percentage: number
  }
}

interface MetricCardProps {
  label: string
  value: string | number
  trend?: 'up' | 'down' | 'neutral'
  color?: 'green' | 'red' | 'blue' | 'yellow' | 'gray'
  icon?: string
}

function MetricCard({ label, value, trend, color = 'gray', icon }: MetricCardProps) {
  const colorClasses = {
    green: 'text-green-600 bg-green-50',
    red: 'text-red-600 bg-red-50',
    blue: 'text-blue-600 bg-blue-50',
    yellow: 'text-yellow-600 bg-yellow-50',
    gray: 'text-gray-600 bg-gray-50'
  }

  const trendIcons = {
    up: '↑',
    down: '↓',
    neutral: '→'
  }

  return (
    <div className="bg-white rounded-lg p-3 border border-gray-200">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-500 uppercase tracking-wide">{label}</span>
        {icon && <span className="text-lg">{icon}</span>}
      </div>
      <div className="flex items-baseline space-x-2">
        <span className={`text-xl font-bold ${colorClasses[color].split(' ')[0]}`}>
          {value}
        </span>
        {trend && (
          <span className={`text-sm ${trend === 'up' ? 'text-green-500' : trend === 'down' ? 'text-red-500' : 'text-gray-500'}`}>
            {trendIcons[trend]}
          </span>
        )}
      </div>
    </div>
  )
}

export default function BarraMetricasTrading() {
  // Buscar métricas de trading
  const { data: metrics } = useQuery<TradingMetrics>(
    'trading-metrics',
    async () => {
      // Buscar dados de múltiplas fontes
      const [stats, botStatus, rateLimit] = await Promise.all([
        api.getTradingStats('24h'),
        fetch('/api/trading/parallel-bot/status').then(res => res.json()),
        fetch('/api/trading/parallel-bot/rate-limit').then(res => res.json())
      ])

      // Calcular métricas combinadas
      return {
        winRate: typeof stats?.winRate === 'string' ? parseFloat(stats.winRate) : (stats?.winRate || 0),
        totalPnL: stats?.totalPnl ? parseFloat(stats.totalPnl) : 0,
        dailyPnL: stats?.totalPnl ? parseFloat(stats.totalPnl) : 0, // Usar totalPnl como dailyPnL temporariamente
        activePositions: botStatus?.data?.activePositions?.length || 0,
        totalTrades: stats?.totalTrades || 0,
        signalSuccessRate: botStatus?.data?.metrics?.signalSuccessRate || 0,
        avgExecutionTime: botStatus?.data?.metrics?.avgExecutionTime || 0,
        apiRateLimit: {
          used: rateLimit?.data?.currentRequests || 0,
          total: rateLimit?.data?.maxRequests || 100,
          percentage: rateLimit?.data ? ((rateLimit.data.currentRequests / rateLimit.data.maxRequests) * 100) : 0
        }
      }
    },
    {
      refetchInterval: 5000, // Atualizar a cada 5 segundos
    }
  )

  // Buscar alertas de performance
  const { data: alerts } = useQuery(
    'performance-alerts',
    async () => {
      const response = await fetch('/api/trading/parallel-bot/performance?minutes=5')
      const data = await response.json()
      return data.data?.alerts || []
    },
    {
      refetchInterval: 10000,
    }
  )

  const formatCurrency = (value: number) => {
    const formatted = Math.abs(value).toFixed(2)
    const prefix = value >= 0 ? '+$' : '-$'
    return prefix + formatted
  }

  const formatPercent = (value: number) => {
    const formatted = Math.abs(value).toFixed(1)
    const prefix = value >= 0 ? '+' : '-'
    return prefix + formatted + '%'
  }

  return (
    <div className="bg-white border-b border-gray-200 shadow-sm">
      <div className="px-6 py-3">
        {/* Linha Superior - Métricas Principais */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 mb-3">
          <MetricCard
            label="P&L Total"
            value={formatCurrency(metrics?.totalPnL || 0)}
            color={metrics?.totalPnL && metrics.totalPnL >= 0 ? 'green' : 'red'}
            trend={metrics?.totalPnL && metrics.totalPnL >= 0 ? 'up' : 'down'}
            icon="💰"
          />
          
          <MetricCard
            label="P&L Diário"
            value={formatCurrency(metrics?.dailyPnL || 0)}
            color={metrics?.dailyPnL && metrics.dailyPnL >= 0 ? 'green' : 'red'}
            trend={metrics?.dailyPnL && metrics.dailyPnL >= 0 ? 'up' : 'down'}
            icon="📊"
          />
          
          <MetricCard
            label="Taxa de Acerto"
            value={formatPercent(metrics?.winRate || 0)}
            color={metrics?.winRate && metrics.winRate >= 50 ? 'green' : 'red'}
            icon="🎯"
          />
          
          <MetricCard
            label="Posições Ativas"
            value={metrics?.activePositions || 0}
            color="blue"
            icon="📈"
          />
          
          <MetricCard
            label="Total Trades"
            value={metrics?.totalTrades || 0}
            color="gray"
            icon="🔄"
          />
          
          <MetricCard
            label="Sucesso Sinais"
            value={formatPercent(metrics?.signalSuccessRate || 0)}
            color={metrics?.signalSuccessRate && metrics.signalSuccessRate >= 60 ? 'green' : 'yellow'}
            icon="📡"
          />
          
          <MetricCard
            label="Tempo Exec"
            value={`${(metrics?.avgExecutionTime || 0).toFixed(0)}ms`}
            color={metrics?.avgExecutionTime && metrics.avgExecutionTime < 1000 ? 'green' : 'yellow'}
            icon="⚡"
          />
          
          <MetricCard
            label="API Limit"
            value={`${metrics?.apiRateLimit.used || 0}/${metrics?.apiRateLimit.total || 100}`}
            color={
              metrics?.apiRateLimit.percentage && metrics.apiRateLimit.percentage > 80 ? 'red' : 
              metrics?.apiRateLimit.percentage && metrics.apiRateLimit.percentage > 60 ? 'yellow' : 
              'green'
            }
            icon="🚦"
          />
        </div>

        {/* Linha Inferior - Alertas e Status */}
        {alerts && alerts.length > 0 && (
          <div className="flex items-center space-x-4 overflow-x-auto">
            <span className="text-sm font-medium text-gray-700">Alertas:</span>
            {alerts.slice(0, 3).map((alert: any, index: number) => (
              <div
                key={index}
                className={`flex items-center space-x-2 px-3 py-1 rounded-full text-xs font-medium ${
                  alert.severity === 'critical' 
                    ? 'bg-red-100 text-red-800' 
                    : 'bg-yellow-100 text-yellow-800'
                }`}
              >
                <span className="animate-pulse">●</span>
                <span>{alert.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}