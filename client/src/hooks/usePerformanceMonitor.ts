import { useEffect, useRef, useCallback } from 'react'

interface PerformanceMetrics {
  renderCount: number
  lastRenderTime: number
  averageRenderTime: number
  slowRenders: number
  componentName: string
}

interface RenderInfo {
  phase: 'mount' | 'update' | 'nested-update'
  actualDuration: number
  baseDuration: number
  startTime: number
  commitTime: number
}

export function usePerformanceMonitor(componentName: string) {
  const metrics = useRef<PerformanceMetrics>({
    renderCount: 0,
    lastRenderTime: 0,
    averageRenderTime: 0,
    slowRenders: 0,
    componentName
  })

  const startTime = useRef<number>(0)

  // Track render start
  useEffect(() => {
    startTime.current = performance.now()
  })

  // Track render end
  useEffect(() => {
    const renderTime = performance.now() - startTime.current
    const m = metrics.current

    m.renderCount++
    m.lastRenderTime = renderTime
    m.averageRenderTime = (m.averageRenderTime * (m.renderCount - 1) + renderTime) / m.renderCount

    // Consider renders over 16ms (1 frame) as slow
    if (renderTime > 16) {
      m.slowRenders++
      console.warn(`[PERF] Slow render in ${componentName}: ${renderTime.toFixed(2)}ms`)
    }

    // Log metrics every 10 renders in development
    if (import.meta.env.DEV && m.renderCount % 10 === 0) {
      console.log(`[PERF] ${componentName} metrics:`, {
        renders: m.renderCount,
        avgTime: `${m.averageRenderTime.toFixed(2)}ms`,
        slowRenders: m.slowRenders,
        slowRate: `${((m.slowRenders / m.renderCount) * 100).toFixed(1)}%`
      })
    }
  })

  // Profiler callback for React DevTools
  const onRenderCallback = useCallback((
    _id: string,
    phase: 'mount' | 'update' | 'nested-update',
    actualDuration: number,
    baseDuration: number,
    startTime: number,
    commitTime: number
  ) => {
    const renderInfo: RenderInfo = {
      phase,
      actualDuration,
      baseDuration,
      startTime,
      commitTime
    }

    // Log slow renders
    if (actualDuration > 16) {
      console.warn(`[PERF] ${componentName} slow ${phase}:`, {
        actual: `${actualDuration.toFixed(2)}ms`,
        base: `${baseDuration.toFixed(2)}ms`,
        ratio: `${(actualDuration / baseDuration * 100).toFixed(1)}%`
      })
    }

    // Store in session storage for analysis
    if (import.meta.env.DEV) {
      const key = `perf_${componentName}_${Date.now()}`
      sessionStorage.setItem(key, JSON.stringify(renderInfo))
      
      // Keep only last 100 entries
      const keys = Object.keys(sessionStorage)
        .filter(k => k.startsWith(`perf_${componentName}_`))
        .sort()
      
      if (keys.length > 100) {
        keys.slice(0, keys.length - 100).forEach(k => sessionStorage.removeItem(k))
      }
    }
  }, [componentName])

  // Get current metrics
  const getMetrics = useCallback(() => metrics.current, [])

  // Reset metrics
  const resetMetrics = useCallback(() => {
    metrics.current = {
      renderCount: 0,
      lastRenderTime: 0,
      averageRenderTime: 0,
      slowRenders: 0,
      componentName
    }
  }, [componentName])

  return {
    onRenderCallback,
    getMetrics,
    resetMetrics
  }
}

// Hook for tracking expensive operations
export function useOperationTimer(operationName: string) {
  const timers = useRef<Map<string, number>>(new Map())

  const startTimer = useCallback((id: string = 'default') => {
    timers.current.set(id, performance.now())
  }, [])

  const endTimer = useCallback((id: string = 'default', threshold: number = 100) => {
    const startTime = timers.current.get(id)
    if (!startTime) {
      console.warn(`[PERF] No start time found for timer: ${id}`)
      return 0
    }

    const duration = performance.now() - startTime
    timers.current.delete(id)

    if (duration > threshold) {
      console.warn(`[PERF] Slow operation "${operationName}.${id}": ${duration.toFixed(2)}ms (threshold: ${threshold}ms)`)
    }

    return duration
  }, [operationName])

  const measureAsync = useCallback(async <T>(
    fn: () => Promise<T>,
    id: string = 'default',
    threshold: number = 1000
  ): Promise<T> => {
    startTimer(id)
    try {
      const result = await fn()
      const duration = endTimer(id, threshold)
      
      if (import.meta.env.DEV) {
        console.debug(`[PERF] Async operation "${operationName}.${id}" completed in ${duration.toFixed(2)}ms`)
      }
      
      return result
    } catch (error) {
      endTimer(id, threshold)
      throw error
    }
  }, [operationName, startTimer, endTimer])

  return {
    startTimer,
    endTimer,
    measureAsync
  }
}

// Hook for tracking memory usage
export function useMemoryMonitor(componentName: string) {
  const initialMemory = useRef<number>(0)

  useEffect(() => {
    if (!('memory' in performance)) return

    const perfMemory = (performance as any).memory
    initialMemory.current = perfMemory.usedJSHeapSize

    return () => {
      const currentMemory = perfMemory.usedJSHeapSize
      const memoryDelta = currentMemory - initialMemory.current
      
      if (Math.abs(memoryDelta) > 1024 * 1024) { // 1MB threshold
        const deltaMB = (memoryDelta / 1024 / 1024).toFixed(2)
        console.log(`[MEMORY] ${componentName} memory delta: ${deltaMB}MB`)
      }
    }
  }, [componentName])
}

// Combined performance hook
export function usePerformance(componentName: string) {
  const { onRenderCallback, getMetrics, resetMetrics } = usePerformanceMonitor(componentName)
  const timer = useOperationTimer(componentName)
  useMemoryMonitor(componentName)

  return {
    onRenderCallback,
    getMetrics,
    resetMetrics,
    ...timer
  }
}