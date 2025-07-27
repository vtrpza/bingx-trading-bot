import { ProcessStep } from '../types'

interface ProcessStepCardProps {
  step: ProcessStep
  isActive: boolean
  mode: 'simplified' | 'professional'
  onClick?: () => void
}

export default function ProcessStepCard({ step, isActive, mode, onClick }: ProcessStepCardProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'processing':
        return 'border-blue-500 bg-blue-50'
      case 'completed':
        return 'border-green-500 bg-green-50'
      case 'error':
        return 'border-red-500 bg-red-50'
      case 'warning':
        return 'border-yellow-500 bg-yellow-50'
      default:
        return 'border-gray-300 bg-gray-50'
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'processing':
        return '🔄'
      case 'completed':
        return '✅'
      case 'error':
        return '❌'
      case 'warning':
        return '⚠️'
      default:
        return '⏸️'
    }
  }

  const getStepIcon = (stepId: string) => {
    const icons = {
      scanning: '🔍',
      analysis: '📊',
      decision: '🤔',
      execution: '⚡'
    }
    return icons[stepId as keyof typeof icons] || '📋'
  }

  const formatDuration = (duration?: number) => {
    if (!duration) return 'N/A'
    if (duration < 1000) return `${duration}ms`
    return `${(duration / 1000).toFixed(1)}s`
  }

  const getTooltipText = () => {
    if (mode === 'simplified') {
      switch (step.id) {
        case 'scanning':
          return 'Monitoring market data and looking for trading opportunities'
        case 'analysis':
          return 'Analyzing price patterns and technical indicators'
        case 'decision':
          return 'Evaluating whether to buy, sell, or wait'
        case 'execution':
          return 'Placing and managing trades'
        default:
          return step.name
      }
    } else {
      return `${step.name}: ${step.status}${step.duration ? ` (${formatDuration(step.duration)})` : ''}`
    }
  }

  return (
    <div
      className={`relative p-4 rounded-lg border-2 transition-all duration-200 cursor-pointer hover:shadow-md ${
        getStatusColor(step.status)
      } ${isActive ? 'ring-2 ring-primary-500 ring-offset-2' : ''}`}
      onClick={onClick}
      title={getTooltipText()}
    >
      {/* Status indicator */}
      <div className="absolute top-2 right-2">
        <span className="text-lg">{getStatusIcon(step.status)}</span>
      </div>

      {/* Step icon and name */}
      <div className="flex items-center space-x-3 mb-2">
        <span className="text-2xl">{getStepIcon(step.id)}</span>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-gray-900 truncate">
            {step.name}
          </h4>
          <p className="text-xs text-gray-500 capitalize">
            {step.status}
          </p>
        </div>
      </div>

      {/* Processing indicator */}
      {step.status === 'processing' && (
        <div className="mb-2">
          <div className="w-full bg-gray-200 rounded-full h-1">
            <div className="bg-blue-600 h-1 rounded-full animate-pulse" style={{ width: '60%' }} />
          </div>
        </div>
      )}

      {/* Professional mode details */}
      {mode === 'professional' && (
        <div className="space-y-1 text-xs text-gray-600">
          {step.duration && (
            <div className="flex justify-between">
              <span>Duration:</span>
              <span className="font-medium">{formatDuration(step.duration)}</span>
            </div>
          )}
          
          {step.startTime && (
            <div className="flex justify-between">
              <span>Started:</span>
              <span className="font-medium">
                {new Date(step.startTime).toLocaleTimeString()}
              </span>
            </div>
          )}

          {step.metadata && Object.keys(step.metadata).length > 0 && (
            <div className="mt-2 p-2 bg-white bg-opacity-50 rounded text-xs">
              {step.metadata.symbolsCount && (
                <div>Symbols: {step.metadata.symbolsCount}</div>
              )}
              {step.metadata.symbol && (
                <div>Symbol: {step.metadata.symbol}</div>
              )}
              {step.metadata.signal && (
                <div>Signal: {step.metadata.signal}</div>
              )}
              {step.metadata.strength && (
                <div>Strength: {step.metadata.strength}%</div>
              )}
            </div>
          )}

          {step.error && (
            <div className="mt-2 p-2 bg-red-100 rounded text-xs text-red-700">
              Error: {step.error}
            </div>
          )}
        </div>
      )}

      {/* Simplified mode details */}
      {mode === 'simplified' && step.status === 'error' && (
        <div className="mt-2 text-xs text-red-700">
          Something went wrong. Check logs for details.
        </div>
      )}

      {/* Active indicator */}
      {isActive && (
        <div className="absolute inset-0 rounded-lg border-2 border-primary-500 pointer-events-none animate-pulse" />
      )}
    </div>
  )
}