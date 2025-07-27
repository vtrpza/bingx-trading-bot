import { EventEmitter } from 'events';
import { ParallelTradingBot } from './ParallelTradingBot';
import { logger } from '../utils/logger';

export interface PerformanceSnapshot {
  timestamp: number;
  botMetrics: any;
  systemMetrics: {
    memoryUsage: NodeJS.MemoryUsage;
    cpuUsage: NodeJS.CpuUsage;
    uptime: number;
    loadAverage: number[];
  };
  componentMetrics: {
    signalWorkerPool: any;
    signalQueue: any;
    tradeExecutorPool: any;
    marketDataCache: any;
  };
  throughputMetrics: {
    signalsPerMinute: number;
    tradesPerMinute: number;
    avgSignalLatency: number;
    avgExecutionLatency: number;
  };
  efficiencyMetrics: {
    workerUtilization: number;
    queueEfficiency: number;
    cacheHitRate: number;
    errorRate: number;
  };
}

export interface PerformanceAlert {
  id: string;
  type: 'high_latency' | 'low_throughput' | 'high_error_rate' | 'resource_exhaustion' | 'queue_overflow';
  severity: 'warning' | 'critical';
  message: string;
  value: number;
  threshold: number;
  timestamp: number;
  resolved: boolean;
}

export interface MonitoringConfig {
  enabled: boolean;
  snapshotInterval: number; // milliseconds
  retentionPeriod: number; // milliseconds
  warmupPeriod: number; // milliseconds - delay before alerting starts
  alertThresholds: {
    highLatency: number;
    lowThroughput: number;
    highErrorRate: number;
    queueOverflow: number;
    memoryUsage: number;
    cpuUsage: number;
  };
  alertCooldown: number; // milliseconds
}

export class PerformanceMonitor extends EventEmitter {
  private bot: ParallelTradingBot;
  private config: MonitoringConfig;
  private isRunning: boolean = false;
  private snapshotInterval: NodeJS.Timeout | null = null;
  
  // Data storage
  private snapshots: PerformanceSnapshot[] = [];
  private alerts: PerformanceAlert[] = [];
  private lastAlerts: Map<string, number> = new Map();
  
  // Tracking variables
  private lastSignalCount: number = 0;
  private lastTradeCount: number = 0;
  private lastSnapshotTime: number = 0;
  private cpuStartUsage: NodeJS.CpuUsage = process.cpuUsage();
  private startTime: number = 0;

  constructor(bot: ParallelTradingBot, config: Partial<MonitoringConfig> = {}) {
    super();
    
    this.bot = bot;
    this.config = {
      enabled: true,
      snapshotInterval: 5000, // 5 seconds
      retentionPeriod: 3600000, // 1 hour
      warmupPeriod: 30000, // 30 seconds warmup before alerts
      alertThresholds: {
        highLatency: 5000, // 5 seconds
        lowThroughput: 10, // signals per minute
        highErrorRate: 20, // percentage
        queueOverflow: 80, // percentage of max queue size
        memoryUsage: 512, // MB
        cpuUsage: 80 // percentage
      },
      alertCooldown: 60000, // 1 minute
      ...config
    };
  }

  start(): void {
    if (this.isRunning || !this.config.enabled) {
      return;
    }

    this.isRunning = true;
    this.startTime = Date.now();
    this.lastSnapshotTime = Date.now();
    
    // Take initial snapshot
    this.takeSnapshot();
    
    // Set up interval
    this.snapshotInterval = setInterval(() => {
      this.takeSnapshot();
      this.analyzePerformance();
      this.cleanupOldData();
    }, this.config.snapshotInterval);

    logger.info('PerformanceMonitor started');
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }

    logger.info('PerformanceMonitor stopped');
  }

  private takeSnapshot(): void {
    try {
      const now = Date.now();
      const botMetrics = this.bot.getMetrics();
      const botStatus = this.bot.getStatus();
      
      // Calculate throughput metrics
      const timeDiff = (now - this.lastSnapshotTime) / 60000; // minutes
      
      const currentSignalCount = botMetrics.signalMetrics.totalGenerated;
      const currentTradeCount = botMetrics.executionMetrics.totalExecuted;
      
      const signalsPerMinute = timeDiff > 0 ? 
        (currentSignalCount - this.lastSignalCount) / timeDiff : 0;
      const tradesPerMinute = timeDiff > 0 ? 
        (currentTradeCount - this.lastTradeCount) / timeDiff : 0;

      // System metrics
      const memoryUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage(this.cpuStartUsage);
      const uptime = process.uptime();
      const loadAverage = require('os').loadavg();

      // Component metrics
      const componentMetrics = {
        signalWorkerPool: botStatus.components.signalWorkerPool,
        signalQueue: botStatus.components.signalQueue,
        tradeExecutorPool: botStatus.components.tradeExecutorPool,
        marketDataCache: botStatus.components.marketDataCache
      };

      // Calculate efficiency metrics
      const workerUtilization = botMetrics.systemMetrics.workerUtilization;
      const cacheHitRate = botMetrics.systemMetrics.cacheHitRate;
      
      const queueEfficiency = componentMetrics.signalQueue.active > 0 ? 
        (componentMetrics.signalQueue.processing / componentMetrics.signalQueue.active) * 100 : 100;

      // Calculate error rate based on actual signal generation failures
      const totalSignalAttempts = botMetrics.signalMetrics.totalGenerated + (botMetrics.signalMetrics.failedSignals || 0);
      const errorRate = totalSignalAttempts > 0 ?
        ((botMetrics.signalMetrics.failedSignals || 0) / totalSignalAttempts) * 100 : 0;

      const snapshot: PerformanceSnapshot = {
        timestamp: now,
        botMetrics,
        systemMetrics: {
          memoryUsage,
          cpuUsage,
          uptime,
          loadAverage
        },
        componentMetrics,
        throughputMetrics: {
          signalsPerMinute,
          tradesPerMinute,
          avgSignalLatency: botMetrics.scanningMetrics.avgScanTime,
          avgExecutionLatency: botMetrics.executionMetrics.avgExecutionTime
        },
        efficiencyMetrics: {
          workerUtilization,
          queueEfficiency,
          cacheHitRate,
          errorRate
        }
      };

      this.snapshots.push(snapshot);
      
      // Update tracking variables
      this.lastSignalCount = currentSignalCount;
      this.lastTradeCount = currentTradeCount;
      this.lastSnapshotTime = now;
      this.cpuStartUsage = process.cpuUsage();

      this.emit('snapshot', snapshot);
      
    } catch (error) {
      logger.error('Error taking performance snapshot:', error);
    }
  }

  private analyzePerformance(): void {
    if (this.snapshots.length === 0) {
      return;
    }

    // Check if we're still in warmup period
    const now = Date.now();
    if (now - this.startTime < this.config.warmupPeriod) {
      return; // Skip alerts during warmup
    }

    const latest = this.snapshots[this.snapshots.length - 1];
    const thresholds = this.config.alertThresholds;

    // Check signal latency
    if (latest.throughputMetrics.avgSignalLatency > thresholds.highLatency) {
      this.createAlert('high_latency', 'critical',
        `High signal processing latency: ${latest.throughputMetrics.avgSignalLatency}ms`,
        latest.throughputMetrics.avgSignalLatency,
        thresholds.highLatency
      );
    }

    // Check execution latency
    if (latest.throughputMetrics.avgExecutionLatency > thresholds.highLatency) {
      this.createAlert('high_latency', 'critical',
        `High trade execution latency: ${latest.throughputMetrics.avgExecutionLatency}ms`,
        latest.throughputMetrics.avgExecutionLatency,
        thresholds.highLatency
      );
    }

    // Check throughput
    if (latest.throughputMetrics.signalsPerMinute < thresholds.lowThroughput) {
      this.createAlert('low_throughput', 'warning',
        `Low signal throughput: ${latest.throughputMetrics.signalsPerMinute.toFixed(1)} signals/min`,
        latest.throughputMetrics.signalsPerMinute,
        thresholds.lowThroughput
      );
    }

    // Check error rate - only alert if there have been actual attempts/failures
    const hasSignalActivity = latest.botMetrics.signalMetrics.totalGenerated > 0 || 
                             (latest.botMetrics.signalMetrics.failedSignals || 0) > 0;
    
    if (hasSignalActivity && latest.efficiencyMetrics.errorRate > thresholds.highErrorRate) {
      this.createAlert('high_error_rate', 'warning',
        `High error rate: ${latest.efficiencyMetrics.errorRate.toFixed(1)}%`,
        latest.efficiencyMetrics.errorRate,
        thresholds.highErrorRate
      );
    }

    // Check queue overflow
    const queueUtilization = (latest.componentMetrics.signalQueue.total / 100) * 100; // Assuming max 100
    if (queueUtilization > thresholds.queueOverflow) {
      this.createAlert('queue_overflow', 'critical',
        `Signal queue near capacity: ${queueUtilization.toFixed(1)}%`,
        queueUtilization,
        thresholds.queueOverflow
      );
    }

    // Check memory usage
    const memoryUsageMB = latest.systemMetrics.memoryUsage.heapUsed / 1024 / 1024;
    if (memoryUsageMB > thresholds.memoryUsage) {
      this.createAlert('resource_exhaustion', 'warning',
        `High memory usage: ${memoryUsageMB.toFixed(1)}MB`,
        memoryUsageMB,
        thresholds.memoryUsage
      );
    }

    // Check CPU usage (approximate)
    const cpuPercent = (latest.systemMetrics.cpuUsage.user + latest.systemMetrics.cpuUsage.system) / 10000;
    if (cpuPercent > thresholds.cpuUsage) {
      this.createAlert('resource_exhaustion', 'warning',
        `High CPU usage: ${cpuPercent.toFixed(1)}%`,
        cpuPercent,
        thresholds.cpuUsage
      );
    }
  }

  private createAlert(
    type: PerformanceAlert['type'],
    severity: PerformanceAlert['severity'],
    message: string,
    value: number,
    threshold: number
  ): void {
    const alertKey = `${type}_${severity}`;
    const lastAlert = this.lastAlerts.get(alertKey);
    const now = Date.now();

    // Check cooldown
    if (lastAlert && (now - lastAlert) < this.config.alertCooldown) {
      return;
    }

    const alert: PerformanceAlert = {
      id: `${type}_${now}`,
      type,
      severity,
      message,
      value,
      threshold,
      timestamp: now,
      resolved: false
    };

    this.alerts.push(alert);
    this.lastAlerts.set(alertKey, now);

    logger.warn(`Performance Alert [${severity.toUpperCase()}]: ${message}`);
    this.emit('alert', alert);
  }

  private cleanupOldData(): void {
    const cutoff = Date.now() - this.config.retentionPeriod;
    
    // Remove old snapshots
    this.snapshots = this.snapshots.filter(snapshot => 
      snapshot.timestamp > cutoff
    );
    
    // Remove old alerts (keep last 100)
    if (this.alerts.length > 100) {
      this.alerts = this.alerts.slice(-100);
    }
  }

  // Public API methods
  getLatestSnapshot(): PerformanceSnapshot | null {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
  }

  getSnapshots(limit?: number): PerformanceSnapshot[] {
    return limit ? this.snapshots.slice(-limit) : [...this.snapshots];
  }

  getActiveAlerts(): PerformanceAlert[] {
    return this.alerts.filter(alert => !alert.resolved);
  }

  getAllAlerts(limit?: number): PerformanceAlert[] {
    return limit ? this.alerts.slice(-limit) : [...this.alerts];
  }

  resolveAlert(alertId: string): boolean {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.resolved = true;
      this.emit('alertResolved', alert);
      return true;
    }
    return false;
  }

  getPerformanceSummary(minutes: number = 60): any {
    const cutoff = Date.now() - (minutes * 60000);
    const recentSnapshots = this.snapshots.filter(s => s.timestamp > cutoff);

    if (recentSnapshots.length === 0) {
      return null;
    }

    const avgThroughput = recentSnapshots.reduce((sum, s) => 
      sum + s.throughputMetrics.signalsPerMinute, 0) / recentSnapshots.length;
    
    const avgLatency = recentSnapshots.reduce((sum, s) => 
      sum + s.throughputMetrics.avgSignalLatency, 0) / recentSnapshots.length;
    
    const avgWorkerUtilization = recentSnapshots.reduce((sum, s) => 
      sum + s.efficiencyMetrics.workerUtilization, 0) / recentSnapshots.length;
    
    const avgCacheHitRate = recentSnapshots.reduce((sum, s) => 
      sum + s.efficiencyMetrics.cacheHitRate, 0) / recentSnapshots.length;

    const totalSignals = recentSnapshots[recentSnapshots.length - 1]?.botMetrics.signalMetrics.totalGenerated - 
                        recentSnapshots[0]?.botMetrics.signalMetrics.totalGenerated;
    
    const totalTrades = recentSnapshots[recentSnapshots.length - 1]?.botMetrics.executionMetrics.totalExecuted - 
                       recentSnapshots[0]?.botMetrics.executionMetrics.totalExecuted;

    return {
      period: `${minutes} minutes`,
      snapshots: recentSnapshots.length,
      averages: {
        signalsPerMinute: avgThroughput,
        avgLatency,
        workerUtilization: avgWorkerUtilization,
        cacheHitRate: avgCacheHitRate
      },
      totals: {
        signals: totalSignals,
        trades: totalTrades
      },
      activeAlerts: this.getActiveAlerts().length,
      efficiency: {
        signalToTradeRatio: totalSignals > 0 ? (totalTrades / totalSignals) * 100 : 0,
        systemUtilization: avgWorkerUtilization
      }
    };
  }

  updateConfig(newConfig: Partial<MonitoringConfig>): void {
    this.config = { ...this.config, ...newConfig };
    
    if (!this.config.enabled && this.isRunning) {
      this.stop();
    } else if (this.config.enabled && !this.isRunning) {
      this.start();
    }
    
    logger.info('PerformanceMonitor configuration updated');
  }

  // Advanced metrics
  getTrendAnalysis(minutes: number = 30): any {
    const cutoff = Date.now() - (minutes * 60000);
    const recentSnapshots = this.snapshots.filter(s => s.timestamp > cutoff);

    if (recentSnapshots.length < 2) {
      return null;
    }

    const first = recentSnapshots[0];
    const last = recentSnapshots[recentSnapshots.length - 1];
    
    const throughputTrend = last.throughputMetrics.signalsPerMinute - first.throughputMetrics.signalsPerMinute;
    const latencyTrend = last.throughputMetrics.avgSignalLatency - first.throughputMetrics.avgSignalLatency;
    const utilizationTrend = last.efficiencyMetrics.workerUtilization - first.efficiencyMetrics.workerUtilization;

    return {
      period: `${minutes} minutes`,
      trends: {
        throughput: {
          change: throughputTrend,
          direction: throughputTrend > 0 ? 'increasing' : throughputTrend < 0 ? 'decreasing' : 'stable'
        },
        latency: {
          change: latencyTrend,
          direction: latencyTrend > 0 ? 'increasing' : latencyTrend < 0 ? 'decreasing' : 'stable'
        },
        utilization: {
          change: utilizationTrend,
          direction: utilizationTrend > 0 ? 'increasing' : utilizationTrend < 0 ? 'decreasing' : 'stable'
        }
      }
    };
  }

  getBottleneckAnalysis(): any {
    const latest = this.getLatestSnapshot();
    if (!latest) {
      return null;
    }

    const bottlenecks = [];

    // Worker pool bottleneck
    if (latest.efficiencyMetrics.workerUtilization > 90) {
      bottlenecks.push({
        component: 'SignalWorkerPool',
        issue: 'High worker utilization',
        severity: 'high',
        recommendation: 'Consider increasing number of workers'
      });
    }

    // Queue bottleneck
    if (latest.componentMetrics.signalQueue.total > 80) {
      bottlenecks.push({
        component: 'SignalQueue',
        issue: 'Queue near capacity',
        severity: 'critical',
        recommendation: 'Increase queue size or improve processing speed'
      });
    }

    // Cache miss rate
    if (latest.efficiencyMetrics.cacheHitRate < 70) {
      bottlenecks.push({
        component: 'MarketDataCache',
        issue: 'Low cache hit rate',
        severity: 'medium',
        recommendation: 'Increase cache TTL or size'
      });
    }

    // High latency
    if (latest.throughputMetrics.avgSignalLatency > 3000) {
      bottlenecks.push({
        component: 'Signal Processing',
        issue: 'High processing latency',
        severity: 'high',
        recommendation: 'Optimize signal generation algorithm or increase timeout'
      });
    }

    return {
      timestamp: latest.timestamp,
      bottlenecks,
      overallHealth: bottlenecks.length === 0 ? 'healthy' : 
                     bottlenecks.some(b => b.severity === 'critical') ? 'critical' :
                     bottlenecks.some(b => b.severity === 'high') ? 'degraded' : 'warning'
    };
  }
}