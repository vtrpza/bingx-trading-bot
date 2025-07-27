import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../config/database';

interface TradeAttributes {
  id: number;
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED';
  quantity: number;
  price: number;
  executedQty: number;
  avgPrice: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  commission: number;
  commissionAsset: string;
  realizedPnl: number;
  signalStrength: number;
  signalReason: string;
  indicators: object;
  executedAt?: Date;
  closedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface TradeCreationAttributes extends Optional<TradeAttributes, 'id' | 'executedQty' | 'avgPrice' | 'commission' | 'realizedPnl' | 'createdAt' | 'updatedAt'> {}

class Trade extends Model<TradeAttributes, TradeCreationAttributes> implements TradeAttributes {
  declare id: number;
  declare orderId: string;
  declare symbol: string;
  declare side: 'BUY' | 'SELL';
  declare positionSide: 'LONG' | 'SHORT';
  declare type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  declare status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED';
  declare quantity: number;
  declare price: number;
  declare executedQty: number;
  declare avgPrice: number;
  declare stopPrice?: number;
  declare takeProfitPrice?: number;
  declare stopLossPrice?: number;
  declare commission: number;
  declare commissionAsset: string;
  declare realizedPnl: number;
  declare signalStrength: number;
  declare signalReason: string;
  declare indicators: object;
  declare executedAt?: Date;
  declare closedAt?: Date;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

Trade.init({
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  orderId: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  symbol: {
    type: DataTypes.STRING,
    allowNull: false
  },
  side: {
    type: DataTypes.ENUM('BUY', 'SELL'),
    allowNull: false
  },
  positionSide: {
    type: DataTypes.ENUM('LONG', 'SHORT'),
    allowNull: false
  },
  type: {
    type: DataTypes.ENUM('LIMIT', 'MARKET', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'),
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'),
    allowNull: false,
    defaultValue: 'NEW'
  },
  quantity: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false
  },
  price: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false
  },
  executedQty: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false,
    defaultValue: 0
  },
  avgPrice: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false,
    defaultValue: 0
  },
  stopPrice: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true
  },
  takeProfitPrice: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true
  },
  stopLossPrice: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true
  },
  commission: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false,
    defaultValue: 0
  },
  commissionAsset: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'USDT'
  },
  realizedPnl: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false,
    defaultValue: 0
  },
  signalStrength: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: false
  },
  signalReason: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  indicators: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: {}
  },
  executedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  closedAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false
  }
}, {
  sequelize,
  modelName: 'Trade',
  tableName: 'trades',
  timestamps: true,
  indexes: [
    { fields: ['orderId'] },
    { fields: ['symbol'] },
    { fields: ['status'] },
    { fields: ['createdAt'] }
  ]
});

export default Trade;