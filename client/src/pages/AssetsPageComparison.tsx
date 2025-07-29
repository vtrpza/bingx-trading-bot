import React, { useState } from 'react'
import AssetsPage from './AssetsPage'
import AssetsPageOptimized from './AssetsPageOptimized'
import { usePerformance } from '../hooks/usePerformanceMonitor'

export default function AssetsPageComparison() {
  const [showOptimized, setShowOptimized] = useState(false)
  const [showMetrics, setShowMetrics] = useState(false)
  
  const originalPerf = usePerformance('AssetsPage-Original')
  const optimizedPerf = usePerformance('AssetsPage-Optimized')

  const handleToggle = () => {
    setShowOptimized(!showOptimized)
    
    // Log metrics on toggle
    if (showMetrics) {
      console.log('Performance Comparison:', {
        original: originalPerf.getMetrics(),
        optimized: optimizedPerf.getMetrics()
      })
    }
  }

  return (
    <div>
      {/* Performance Toggle */}
      <div className="mb-4 p-4 bg-gray-100 rounded-lg flex items-center justify-between">
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showOptimized}
              onChange={handleToggle}
              className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
            />
            <span className="font-medium">
              Use Optimized Version {showOptimized ? '🚀' : '🐌'}
            </span>
          </label>
          
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showMetrics}
              onChange={(e) => setShowMetrics(e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
            />
            <span className="text-sm text-gray-600">Show Performance Metrics</span>
          </label>
        </div>

        {showMetrics && (
          <div className="text-xs text-gray-500">
            <span>Check console for detailed metrics</span>
          </div>
        )}
      </div>

      {/* Render the appropriate version */}
      <React.Profiler
        id={showOptimized ? 'assets-optimized' : 'assets-original'}
        onRender={(id, phase, actualDuration, baseDuration, startTime, commitTime) => {
          const callback = showOptimized ? optimizedPerf.onRenderCallback : originalPerf.onRenderCallback;
          callback(id, phase as 'mount' | 'update' | 'nested-update', actualDuration, baseDuration, startTime, commitTime);
        }}
      >
        {showOptimized ? <AssetsPageOptimized /> : <AssetsPage />}
      </React.Profiler>

      {/* Performance Metrics Display (Development Only) */}
      {showMetrics && import.meta.env.DEV && (
        <div className="fixed bottom-4 right-4 bg-white shadow-lg rounded-lg p-4 max-w-sm">
          <h3 className="font-semibold mb-2">Performance Metrics</h3>
          <div className="space-y-2 text-sm">
            <div>
              <span className="font-medium">Version:</span>{' '}
              {showOptimized ? 'Optimized 🚀' : 'Original 🐌'}
            </div>
            <button
              onClick={() => {
                const metrics = showOptimized 
                  ? optimizedPerf.getMetrics() 
                  : originalPerf.getMetrics()
                console.table(metrics)
                
                // Also log API metrics if using optimized API
                if ((window as any).__API_METRICS__) {
                  console.log('API Metrics:', (window as any).__API_METRICS__())
                }
              }}
              className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              Log Detailed Metrics
            </button>
          </div>
        </div>
      )}
    </div>
  )
}