import WebSocket from 'ws';
import { Server } from 'http';
import { logger } from '../utils/logger';
import { bingxClient } from './bingxClient';
import { EventEmitter } from 'events';

interface MarketDataSubscription {
  symbol: string;
  type: 'kline' | 'depth' | 'trade' | 'ticker';
  interval?: string;
}

class BingXWebSocketManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private subscriptions: Set<string> = new Set();
  private listenKey: string | null = null;
  private wsUrl: string;
  private isConnecting: boolean = false;

  constructor() {
    super();
    this.wsUrl = process.env.BINGX_WS_URL || 'wss://open-api-ws.bingx.com/market';
  }

  async connect() {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;

    try {
      // Get listen key for authenticated streams
      const listenKeyData = await bingxClient.createListenKey();
      this.listenKey = listenKeyData.listenKey;

      // Connect to WebSocket
      this.ws = new WebSocket(`${this.wsUrl}?listenKey=${this.listenKey}`);

      this.ws.on('open', () => {
        logger.info('BingX WebSocket connected');
        this.isConnecting = false;
        this.setupPingInterval();
        this.resubscribe();
        this.emit('connected');
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          // Handle different data types
          let messageStr: string;
          
          if (Buffer.isBuffer(data)) {
            // Check if data is compressed (starts with compression magic bytes)
            if (data[0] === 0x1f && data[1] === 0x8b) {
              // This is gzip compressed data, skip for now
              logger.debug('Received compressed WebSocket data, skipping...');
              return;
            }
            messageStr = data.toString('utf8');
          } else if (typeof data === 'string') {
            messageStr = data;
          } else {
            messageStr = data.toString();
          }
          
          // Skip empty or non-JSON messages
          if (!messageStr || messageStr.trim().length === 0) {
            return;
          }
          
          const message = JSON.parse(messageStr);
          this.handleMessage(message);
        } catch (error) {
          // Only log actual parsing errors, not compression/binary data
          if (error instanceof SyntaxError && error.message.includes('JSON')) {
            logger.debug('Received non-JSON WebSocket message, skipping...');
          } else {
            logger.error('Failed to parse WebSocket message:', error);
          }
        }
      });

      this.ws.on('error', (error) => {
        logger.error('WebSocket error:', error);
        this.emit('error', error);
      });

      this.ws.on('close', () => {
        logger.warn('WebSocket disconnected');
        this.isConnecting = false;
        this.cleanup();
        this.scheduleReconnect();
        this.emit('disconnected');
      });

    } catch (error) {
      logger.error('Failed to connect to WebSocket:', error);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private handleMessage(message: any) {
    // Handle different message types
    if (message.e) {
      switch (message.e) {
        case 'kline':
          this.emit('kline', {
            symbol: message.s,
            interval: message.k.i,
            data: {
              openTime: message.k.t,
              open: parseFloat(message.k.o),
              high: parseFloat(message.k.h),
              low: parseFloat(message.k.l),
              close: parseFloat(message.k.c),
              volume: parseFloat(message.k.v),
              closeTime: message.k.T,
              quoteVolume: parseFloat(message.k.q),
              trades: message.k.n,
              isFinal: message.k.x
            }
          });
          break;

        case '24hrTicker':
          this.emit('ticker', {
            symbol: message.s,
            data: {
              priceChange: parseFloat(message.p),
              priceChangePercent: parseFloat(message.P),
              lastPrice: parseFloat(message.c),
              volume: parseFloat(message.v),
              quoteVolume: parseFloat(message.q),
              high: parseFloat(message.h),
              low: parseFloat(message.l)
            }
          });
          break;

        case 'trade':
          this.emit('trade', {
            symbol: message.s,
            data: {
              price: parseFloat(message.p),
              quantity: parseFloat(message.q),
              time: message.T,
              isBuyerMaker: message.m
            }
          });
          break;

        case 'depthUpdate':
          this.emit('depth', {
            symbol: message.s,
            data: {
              bids: message.b.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]),
              asks: message.a.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]),
              lastUpdateId: message.u
            }
          });
          break;

        // Account updates
        case 'ACCOUNT_UPDATE':
          this.emit('accountUpdate', message);
          break;

        case 'ORDER_TRADE_UPDATE':
          this.emit('orderUpdate', message);
          break;
      }
    }
  }

  subscribe(subscription: MarketDataSubscription) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('WebSocket not connected, queueing subscription');
      return;
    }

    const subKey = this.getSubscriptionKey(subscription);
    if (this.subscriptions.has(subKey)) {
      return;
    }

    const subMessage = this.buildSubscriptionMessage(subscription);
    this.ws.send(JSON.stringify(subMessage));
    this.subscriptions.add(subKey);
    logger.info(`Subscribed to ${subKey}`);
  }

  unsubscribe(subscription: MarketDataSubscription) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const subKey = this.getSubscriptionKey(subscription);
    if (!this.subscriptions.has(subKey)) {
      return;
    }

    const unsubMessage = this.buildUnsubscriptionMessage(subscription);
    this.ws.send(JSON.stringify(unsubMessage));
    this.subscriptions.delete(subKey);
    logger.info(`Unsubscribed from ${subKey}`);
  }

  private getSubscriptionKey(sub: MarketDataSubscription): string {
    return `${sub.symbol}_${sub.type}_${sub.interval || ''}`;
  }

  private buildSubscriptionMessage(sub: MarketDataSubscription): any {
    const streamName = this.getStreamName(sub);
    return {
      id: Date.now().toString(),
      method: 'SUBSCRIBE',
      params: [streamName]
    };
  }

  private buildUnsubscriptionMessage(sub: MarketDataSubscription): any {
    const streamName = this.getStreamName(sub);
    return {
      id: Date.now().toString(),
      method: 'UNSUBSCRIBE',
      params: [streamName]
    };
  }

  private getStreamName(sub: MarketDataSubscription): string {
    const symbol = sub.symbol.toLowerCase();
    switch (sub.type) {
      case 'kline':
        return `${symbol}@kline_${sub.interval}`;
      case 'ticker':
        return `${symbol}@ticker`;
      case 'trade':
        return `${symbol}@aggTrade`;
      case 'depth':
        return `${symbol}@depth`;
      default:
        throw new Error(`Unknown subscription type: ${sub.type}`);
    }
  }

  private resubscribe() {
    // Resubscribe to all previous subscriptions
    const subs = Array.from(this.subscriptions);
    this.subscriptions.clear();
    
    subs.forEach(subKey => {
      const [symbol, type, interval] = subKey.split('_');
      this.subscribe({ symbol, type: type as any, interval });
    });
  }

  private setupPingInterval() {
    // Keep connection alive
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        
        // Keep listen key alive
        if (this.listenKey) {
          bingxClient.keepAliveListenKey(this.listenKey).catch(error => {
            logger.error('Failed to keep alive listen key:', error);
          });
        }
      }
    }, 120000); // 30 seconds
  }

  private scheduleReconnect() {
    if (this.reconnectInterval) {
      return;
    }

    this.reconnectInterval = setInterval(() => {
      logger.info('Attempting to reconnect WebSocket...');
      this.connect();
    }, 5000); // Try to reconnect every 5 seconds
  }

  private cleanup() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }

    if (this.listenKey) {
      bingxClient.closeListenKey(this.listenKey).catch(error => {
        logger.error('Failed to close listen key:', error);
      });
      this.listenKey = null;
    }
  }

  disconnect() {
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Export singleton instance
export const wsManager = new BingXWebSocketManager();

// Setup WebSocket server for client connections
export function setupWebSocket(server: Server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    logger.info('Client WebSocket connected');

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        handleClientMessage(ws, data);
      } catch (error) {
        logger.error('Invalid client message:', error);
      }
    });

    ws.on('close', () => {
      logger.info('Client WebSocket disconnected');
    });
  });

  // Forward BingX WebSocket data to clients
  wsManager.on('kline', (data) => {
    broadcast(wss, { type: 'kline', data });
  });

  wsManager.on('ticker', (data) => {
    broadcast(wss, { type: 'ticker', data });
  });

  wsManager.on('trade', (data) => {
    broadcast(wss, { type: 'trade', data });
  });

  wsManager.on('depth', (data) => {
    broadcast(wss, { type: 'depth', data });
  });

  wsManager.on('accountUpdate', (data) => {
    broadcast(wss, { type: 'accountUpdate', data });
  });

  wsManager.on('orderUpdate', (data) => {
    broadcast(wss, { type: 'orderUpdate', data });
  });

  // Connect to BingX WebSocket
  wsManager.connect();
}

function handleClientMessage(_ws: WebSocket, message: any) {
  switch (message.action) {
    case 'subscribe':
      wsManager.subscribe(message.data);
      break;
    case 'unsubscribe':
      wsManager.unsubscribe(message.data);
      break;
  }
}

function broadcast(wss: WebSocket.Server, data: any) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}