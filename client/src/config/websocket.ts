// WebSocket configuration with automatic protocol detection
export const getWebSocketUrl = (path: string = '/ws'): string => {
  // In development, always use the local server
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return `ws://localhost:3001${path}`;
  }
  
  // In production (Render), connect directly to backend service
  // Frontend is static site, backend handles WebSocket connections
  if (window.location.hostname.includes('onrender.com')) {
    return `wss://bingx-trading-bot-lu0z.onrender.com${path}`;
  }
  
  // Fallback: auto-detect protocol based on current page
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return `${protocol}//${host}${path}`;
};

// Fallback WebSocket URL for cases where WSS fails
export const getFallbackWebSocketUrl = (path: string = '/ws'): string => {
  // Try the opposite protocol if the main one fails
  const protocol = window.location.protocol === 'https:' ? 'ws:' : 'wss:';
  const host = window.location.host;
  
  return `${protocol}//${host}${path}`;
};

// WebSocket configuration options
export const webSocketConfig = {
  // Reconnection settings
  reconnectInterval: 3000,
  maxReconnectAttempts: 10,
  
  // Connection timeout
  connectionTimeout: 10000,
  
  // Keep alive settings
  pingInterval: 30000,
  pongTimeout: 5000
};

// Environment-specific WebSocket debugging
export const enableWebSocketDebug = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// WebSocket status messages
export const getConnectionStatusMessage = (status: string): string => {
  switch (status) {
    case 'connecting':
      return 'Conectando ao servidor...';
    case 'connected':
      return 'Conectado';
    case 'disconnected':
      return 'Desconectado';
    case 'error':
      return 'Erro de conexão';
    default:
      return 'Status desconhecido';
  }
};