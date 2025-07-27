import { useState, useEffect } from 'react'
import { useQuery } from 'react-query'
import { api } from '../services/api'
import { useWebSocket } from '../hooks/useWebSocket'
import { useLocalStorage } from '../hooks/useLocalStorage'
// import { useTranslation } from '../hooks/useTranslation'
import type { TradingFlowState, ActivityEvent, ProcessMetrics, FlowMonitorConfig } from '../types'
import ProcessStepCard from './ProcessStepCard'
import SignalJourneyTracker from './SignalJourneyTracker'
import ActivityTimeline from './ActivityTimeline'

export default function TradingFlowMonitor() {
  // const { t } = useTranslation()
  const { lastMessage } = useWebSocket('/ws')
  
  // Configuration state
  const [config, setConfig] = useLocalStorage<FlowMonitorConfig>('flowMonitorConfig', {
    mode: 'simplified',
    autoRefresh: true,
    refreshInterval: 3000,
    showMetrics: true,
    showErrors: true,
    maxActivityEvents: 20
  })

  // UI state
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<'pipeline' | 'signals' | 'activity' | 'metrics'>('pipeline')

  // Get flow state
  const { data: flowState, isLoading: flowLoading } = useQuery<TradingFlowState>(
    'bot-flow-state',
    api.getBotFlowState,
    {
      refetchInterval: config.autoRefresh ? config.refreshInterval : false,
      enabled: config.autoRefresh
    }
  )

  // Get activity events
  const { data: activityEvents } = useQuery<ActivityEvent[]>(
    'bot-activity-events',
    () => api.getBotActivityEvents(config.maxActivityEvents),
    {
      refetchInterval: config.autoRefresh ? config.refreshInterval : false,
      enabled: config.autoRefresh
    }
  )

  // Get process metrics
  const { data: processMetrics } = useQuery<ProcessMetrics>(
    'bot-process-metrics',
    api.getBotProcessMetrics,
    {
      refetchInterval: config.autoRefresh ? config.refreshInterval * 2 : false,
      enabled: config.autoRefresh && config.showMetrics
    }
  )

  // Handle WebSocket updates
  useEffect(() => {
    if (lastMessage) {
      const data = JSON.parse(lastMessage.data)
      
      if (data.type === 'processUpdate' || data.type === 'activityEvent') {
        // Trigger refetch of flow state and activity events
        if (config.autoRefresh) {
          // The useQuery will automatically refetch due to refetchInterval
        }
      }
    }
  }, [lastMessage, config.autoRefresh])

  const getStepIcon = (stepId: string) => {
    const icons = {
      scanning: '🔍',
      analysis: '📊',
      decision: '🤔',
      execution: '⚡'
    }
    return icons[stepId as keyof typeof icons] || '📋'
  }

  const getStepStatusColor = (status: string) => {
    switch (status) {
      case 'processing':
        return 'text-blue-600 bg-blue-100'
      case 'completed':
        return 'text-green-600 bg-green-100'
      case 'error':
        return 'text-red-600 bg-red-100'
      case 'warning':
        return 'text-yellow-600 bg-yellow-100'
      default:
        return 'text-gray-600 bg-gray-100'
    }
  }

  const toggleMode = () => {
    setConfig(prev => ({
      ...prev,
      mode: prev.mode === 'simplified' ? 'professional' : 'simplified'
    }))
  }

  if (flowLoading) {
    return (
      <div className="card p-6">
        <div className="flex items-center justify-center h-32">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto mb-2"></div>
            <div className="text-gray-600">Loading trading flow...</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="card p-6">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h3 className="text-lg font-medium text-gray-900">Trading Flow Monitor</h3>
            <p className="text-sm text-gray-500">
              {config.mode === 'simplified' ? 'Simplified view for everyone' : 'Professional view with detailed metrics'}
            </p>
          </div>
          
          <div className="flex items-center space-x-4">
            {/* Mode Toggle */}
            <button
              onClick={toggleMode}
              className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                config.mode === 'professional'
                  ? 'bg-blue-100 text-blue-800'
                  : 'bg-gray-100 text-gray-800'
              }`}
            >
              {config.mode === 'simplified' ? '👋 Simple' : '👨‍💼 Pro'}
            </button>

            {/* Auto-refresh indicator */}
            <div className="flex items-center space-x-2">
              <div className={`w-2 h-2 rounded-full ${config.autoRefresh ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
              <span className="text-xs text-gray-500">
                {config.autoRefresh ? 'Live' : 'Manual'}
              </span>
            </div>
          </div>
        </div>

        {/* View Tabs */}
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-8">
            {[
              { id: 'pipeline', name: 'Process Pipeline', icon: '🔄' },
              { id: 'signals', name: 'Signal Journey', icon: '📡' },
              { id: 'activity', name: 'Live Activity', icon: '📊' },
              ...(config.mode === 'professional' ? [{ id: 'metrics', name: 'Performance', icon: '⚡' }] : [])
            ].map((tab, _index) => (
              <button
                key={tab.id}
                onClick={() => setActiveView(tab.id as any)}
                className={`py-2 px-1 border-b-2 font-medium text-sm whitespace-nowrap ${
                  activeView === tab.id
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <span className="mr-2">{tab.icon}</span>
                {tab.name}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Content based on active view */}
      {activeView === 'pipeline' && (
        <div className="space-y-4">
          {/* Current Status */}
          {flowState && (
            <div className="card p-6">
              <h4 className="text-md font-medium text-gray-900 mb-4">Current Process Status</h4>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {flowState.steps.map((step, _index) => (
                  <ProcessStepCard
                    key={step.id}
                    step={step}
                    isActive={step.id === flowState.currentStep}
                    mode={config.mode}
                    onClick={() => {
                      // Could show more details in a modal
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Process Flow Visual */}
          {flowState && (
            <div className="card p-6">
              <h4 className="text-md font-medium text-gray-900 mb-4">Process Flow</h4>
              <div className="flex items-center justify-between">
                {flowState.steps.map((step, stepIndex) => (
                  <div key={step.id} className="flex items-center">
                    <div className={`p-3 rounded-full ${getStepStatusColor(step.status)}`}>
                      <span className="text-lg">{getStepIcon(step.id)}</span>
                    </div>
                    
                    <div className="ml-3 min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900">{step.name}</p>
                      <p className="text-xs text-gray-500 capitalize">{step.status}</p>
                      {config.mode === 'professional' && step.duration && (
                        <p className="text-xs text-gray-400">{step.duration}ms</p>
                      )}
                    </div>
                    
                    {stepIndex < flowState.steps.length - 1 && (
                      <div className="ml-4 mr-4">
                        <div className="w-8 h-px bg-gray-300"></div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Execution Queue */}
          {flowState && flowState.executionQueue.length > 0 && (
            <div className="card p-6">
              <h4 className="text-md font-medium text-gray-900 mb-4">Execution Queue</h4>
              <div className="space-y-2">
                {flowState.executionQueue.slice(0, 5).map((trade) => (
                  <div key={trade.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center space-x-3">
                      <span className={`w-2 h-2 rounded-full ${
                        trade.status === 'processing' ? 'bg-blue-500' :
                        trade.status === 'executed' ? 'bg-green-500' :
                        trade.status === 'failed' ? 'bg-red-500' : 'bg-yellow-500'
                      }`} />
                      <span className="font-medium">{trade.symbol}</span>
                      <span className={`px-2 py-1 text-xs rounded-full ${
                        trade.action === 'BUY' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                      }`}>
                        {trade.action}
                      </span>
                    </div>
                    <div className="text-sm text-gray-500">
                      Priority: {trade.priority}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {activeView === 'signals' && (
        <SignalJourneyTracker
          activeSignals={flowState?.activeSignals || []}
          selectedSignalId={selectedSignalId}
          onSelectSignal={setSelectedSignalId}
          mode={config.mode}
        />
      )}

      {activeView === 'activity' && (
        <ActivityTimeline
          events={(activityEvents as ActivityEvent[]) || []}
          mode={config.mode}
          showErrors={config.showErrors}
        />
      )}

      {activeView === 'metrics' && config.mode === 'professional' && processMetrics && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Performance Metrics */}
          <div className="card p-6">
            <h4 className="text-md font-medium text-gray-900 mb-4">Performance Metrics</h4>
            <div className="space-y-4">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Scanning Rate:</span>
                <span className="text-sm font-medium">{processMetrics.scanningRate.toFixed(1)} symbols/min</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Signal Generation Rate:</span>
                <span className="text-sm font-medium">{processMetrics.signalGenerationRate.toFixed(1)} signals/hour</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Execution Success Rate:</span>
                <span className="text-sm font-medium">{processMetrics.executionSuccessRate.toFixed(1)}%</span>
              </div>
            </div>
          </div>

          {/* Processing Times */}
          <div className="card p-6">
            <h4 className="text-md font-medium text-gray-900 mb-4">Average Processing Times</h4>
            <div className="space-y-4">
              {Object.entries(processMetrics.averageProcessingTime).map(([step, time]) => (
                <div key={step} className="flex justify-between">
                  <span className="text-sm text-gray-600 capitalize">{step}:</span>
                  <span className="text-sm font-medium">{time.toFixed(0)}ms</span>
                </div>
              ))}
            </div>
          </div>

          {/* Performance Stats */}
          <div className="card p-6">
            <h4 className="text-md font-medium text-gray-900 mb-4">Session Statistics</h4>
            <div className="space-y-4">
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Total Scanned:</span>
                <span className="text-sm font-medium">{processMetrics.performance.totalScanned}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Signals Generated:</span>
                <span className="text-sm font-medium">{processMetrics.performance.signalsGenerated}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Trades Executed:</span>
                <span className="text-sm font-medium">{processMetrics.performance.tradesExecuted}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-gray-600">Errors:</span>
                <span className="text-sm font-medium text-red-600">{processMetrics.performance.errors}</span>
              </div>
            </div>
          </div>

          {/* Bottlenecks */}
          {processMetrics.bottlenecks.length > 0 && (
            <div className="card p-6">
              <h4 className="text-md font-medium text-gray-900 mb-4">Identified Bottlenecks</h4>
              <div className="space-y-2">
                {processMetrics.bottlenecks.map((bottleneck, index) => (
                  <div key={index} className="flex items-center space-x-2">
                    <span className="w-2 h-2 bg-red-500 rounded-full" />
                    <span className="text-sm text-red-700">{bottleneck}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}