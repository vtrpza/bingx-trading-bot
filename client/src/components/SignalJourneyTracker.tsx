import { SignalInProcess } from '../types'

interface SignalJourneyTrackerProps {
  activeSignals: SignalInProcess[]
  selectedSignalId: string | null
  onSelectSignal: (signalId: string | null) => void
  mode: 'simplified' | 'professional'
}

export default function SignalJourneyTracker({ 
  activeSignals, 
  selectedSignalId, 
  onSelectSignal, 
  mode 
}: SignalJourneyTrackerProps) {
  
  const getStageColor = (stage: string) => {
    switch (stage) {
      case 'analyzing':
        return 'bg-blue-100 text-blue-800'
      case 'evaluating':
        return 'bg-yellow-100 text-yellow-800'
      case 'decided':
        return 'bg-purple-100 text-purple-800'
      case 'queued':
        return 'bg-orange-100 text-orange-800'
      case 'executing':
        return 'bg-indigo-100 text-indigo-800'
      case 'completed':
        return 'bg-green-100 text-green-800'
      case 'rejected':
        return 'bg-red-100 text-red-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  const getStageIcon = (stage: string) => {
    switch (stage) {
      case 'analyzing':
        return '🔍'
      case 'evaluating':
        return '⚖️'
      case 'decided':
        return '✅'
      case 'queued':
        return '⏳'
      case 'executing':
        return '⚡'
      case 'completed':
        return '🎯'
      case 'rejected':
        return '❌'
      default:
        return '📊'
    }
  }

  const getStageDescription = (stage: string, mode: 'simplified' | 'professional') => {
    if (mode === 'simplified') {
      switch (stage) {
        case 'analyzing':
          return 'Looking at market data'
        case 'evaluating':
          return 'Checking trading conditions'
        case 'decided':
          return 'Decision made'
        case 'queued':
          return 'Waiting to trade'
        case 'executing':
          return 'Placing trade'
        case 'completed':
          return 'Trade completed'
        case 'rejected':
          return 'Trade rejected'
        default:
          return 'Processing'
      }
    } else {
      switch (stage) {
        case 'analyzing':
          return 'Technical indicator analysis in progress'
        case 'evaluating':
          return 'Evaluating signal conditions and risk parameters'
        case 'decided':
          return 'Trading decision finalized'
        case 'queued':
          return 'Queued for execution'
        case 'executing':
          return 'Order placement and execution'
        case 'completed':
          return 'Signal processing completed successfully'
        case 'rejected':
          return 'Signal rejected due to conditions not met'
        default:
          return 'Signal processing'
      }
    }
  }

  const formatElapsedTime = (startTime: number) => {
    const elapsed = Date.now() - startTime
    if (elapsed < 1000) return `${elapsed}ms`
    if (elapsed < 60000) return `${(elapsed / 1000).toFixed(1)}s`
    return `${(elapsed / 60000).toFixed(1)}m`
  }

  const selectedSignal = selectedSignalId 
    ? activeSignals.find(signal => signal.id === selectedSignalId)
    : null

  return (
    <div className="space-y-6">
      {/* Active Signals List */}
      <div className="card p-6">
        <h4 className="text-md font-medium text-gray-900 mb-4">
          Active Signal Processing ({activeSignals.length})
        </h4>
        
        {activeSignals.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <span className="text-2xl mb-2 block">📡</span>
            No signals currently being processed
          </div>
        ) : (
          <div className="space-y-3">
            {activeSignals.map((signal) => (
              <div
                key={signal.id}
                className={`p-4 rounded-lg border cursor-pointer transition-all ${
                  selectedSignalId === signal.id
                    ? 'border-primary-500 bg-primary-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
                onClick={() => onSelectSignal(signal.id === selectedSignalId ? null : signal.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <span className="text-lg">{getStageIcon(signal.stage)}</span>
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-medium text-gray-900">{signal.symbol}</span>
                        <span className={`px-2 py-1 text-xs rounded-full ${getStageColor(signal.stage)}`}>
                          {signal.stage}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600">
                        {getStageDescription(signal.stage, mode)}
                      </p>
                    </div>
                  </div>
                  
                  <div className="text-right">
                    <p className="text-sm font-medium text-gray-900">
                      {formatElapsedTime(signal.startTime)}
                    </p>
                    {signal.signal && (
                      <p className="text-xs text-gray-500">
                        {signal.signal.action} ({signal.signal.strength}%)
                      </p>
                    )}
                  </div>
                </div>

                {/* Decision and rejection reason */}
                {signal.decision && (
                  <div className="mt-2 text-sm">
                    <span className={`inline-flex px-2 py-1 rounded text-xs ${
                      signal.decision === 'execute' 
                        ? 'bg-green-100 text-green-800' 
                        : 'bg-red-100 text-red-800'
                    }`}>
                      Decision: {signal.decision}
                    </span>
                  </div>
                )}

                {signal.rejectionReason && (
                  <div className="mt-2 text-sm text-red-600">
                    Reason: {signal.rejectionReason}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Signal Details */}
      {selectedSignal && (
        <div className="card p-6">
          <h4 className="text-md font-medium text-gray-900 mb-4">
            Signal Details: {selectedSignal.symbol}
          </h4>

          {/* Signal Journey Timeline */}
          <div className="mb-6">
            <h5 className="text-sm font-medium text-gray-700 mb-3">Processing Timeline</h5>
            <div className="flex items-center space-x-4">
              {[
                { stage: 'analyzing', label: 'Analysis' },
                { stage: 'evaluating', label: 'Evaluation' },
                { stage: 'decided', label: 'Decision' },
                { stage: 'queued', label: 'Queue' },
                { stage: 'executing', label: 'Execution' },
                { stage: 'completed', label: 'Complete' }
              ].map((step, index) => {
                const isActive = selectedSignal.stage === step.stage
                const isPassed = ['analyzing', 'evaluating', 'decided', 'queued', 'executing'].indexOf(selectedSignal.stage) > 
                                ['analyzing', 'evaluating', 'decided', 'queued', 'executing'].indexOf(step.stage)
                const isRejected = selectedSignal.stage === 'rejected'

                return (
                  <div key={step.stage} className="flex items-center">
                    <div className={`p-2 rounded-full text-sm ${
                      isRejected && step.stage !== 'analyzing' ? 'bg-gray-100 text-gray-400' :
                      isActive ? 'bg-blue-100 text-blue-800' :
                      isPassed ? 'bg-green-100 text-green-800' :
                      'bg-gray-100 text-gray-400'
                    }`}>
                      {getStageIcon(step.stage)}
                    </div>
                    <span className={`ml-2 text-xs ${
                      isRejected && step.stage !== 'analyzing' ? 'text-gray-400' :
                      isActive ? 'text-blue-700 font-medium' :
                      isPassed ? 'text-green-700' :
                      'text-gray-400'
                    }`}>
                      {step.label}
                    </span>
                    {index < 5 && (
                      <div className={`mx-2 h-px w-8 ${
                        isRejected && step.stage !== 'analyzing' ? 'bg-gray-200' :
                        isPassed ? 'bg-green-300' : 'bg-gray-200'
                      }`} />
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Signal Information */}
          {selectedSignal.signal && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Signal Details */}
              <div>
                <h5 className="text-sm font-medium text-gray-700 mb-3">Signal Information</h5>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Action:</span>
                    <span className={`font-medium ${
                      selectedSignal.signal.action === 'BUY' ? 'text-green-600' :
                      selectedSignal.signal.action === 'SELL' ? 'text-red-600' :
                      'text-gray-600'
                    }`}>
                      {selectedSignal.signal.action}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Strength:</span>
                    <span className="font-medium">{selectedSignal.signal.strength}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Processing Time:</span>
                    <span className="font-medium">{formatElapsedTime(selectedSignal.startTime)}</span>
                  </div>
                  {selectedSignal.executionTime && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Total Time:</span>
                      <span className="font-medium">{selectedSignal.executionTime}ms</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Technical Indicators (Professional Mode) */}
              {mode === 'professional' && selectedSignal.signal.indicators && (
                <div>
                  <h5 className="text-sm font-medium text-gray-700 mb-3">Technical Indicators</h5>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Price:</span>
                      <span className="font-medium">${selectedSignal.signal.indicators.price?.toFixed(4)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">RSI:</span>
                      <span className="font-medium">{selectedSignal.signal.indicators.rsi?.toFixed(1)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">MA1:</span>
                      <span className="font-medium">${selectedSignal.signal.indicators.ma1?.toFixed(4)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">MA2:</span>
                      <span className="font-medium">${selectedSignal.signal.indicators.ma2?.toFixed(4)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Rejection Reason */}
          {selectedSignal.rejectionReason && (
            <div className="mt-4 p-3 bg-red-50 rounded-lg">
              <h5 className="text-sm font-medium text-red-800 mb-1">Rejection Reason</h5>
              <p className="text-sm text-red-700">{selectedSignal.rejectionReason}</p>
            </div>
          )}

          {/* Signal Reason */}
          {selectedSignal.signal?.reason && (
            <div className="mt-4 p-3 bg-gray-50 rounded-lg">
              <h5 className="text-sm font-medium text-gray-800 mb-1">Analysis Summary</h5>
              <p className="text-sm text-gray-700">{selectedSignal.signal.reason}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}