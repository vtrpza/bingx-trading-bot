import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../config/database';

interface AssetAttributes {
  id: number;
  symbol: string;
  name: string;
  baseCurrency: string;
  quoteCurrency: string;
  status: string;
  minQty: number;
  maxQty: number;
  tickSize: number;
  stepSize: number;
  maxLeverage: number;
  maintMarginRate: number;
  volume24h: number;
  quoteVolume24h: number;
  openInterest: number;
  lastPrice: number;
  priceChangePercent: number;
  highPrice24h: number;
  lowPrice24h: number;
  updatedAt: Date;
  createdAt: Date;
}

interface AssetCreationAttributes extends Optional<AssetAttributes, 'id' | 'createdAt' | 'updatedAt'> {}

class Asset extends Model<AssetAttributes, AssetCreationAttributes> implements AssetAttributes {
  declare id: number;
  declare symbol: string;
  declare name: string;
  declare baseCurrency: string;
  declare quoteCurrency: string;
  declare status: string;
  declare minQty: number;
  declare maxQty: number;
  declare tickSize: number;
  declare stepSize: number;
  declare maxLeverage: number;
  declare maintMarginRate: number;
  declare volume24h: number;
  declare quoteVolume24h: number;
  declare openInterest: number;
  declare lastPrice: number;
  declare priceChangePercent: number;
  declare highPrice24h: number;
  declare lowPrice24h: number;
  declare readonly updatedAt: Date;
  declare readonly createdAt: Date;
}

Asset.init({
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  symbol: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  baseCurrency: {
    type: DataTypes.STRING,
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 'UNKNOWN'
  },
  quoteCurrency: {
    type: DataTypes.STRING,
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 'USDT'
  },
  status: {
    type: DataTypes.STRING,
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 'UNKNOWN'
  },
  minQty: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 0
  },
  maxQty: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 999999999
  },
  tickSize: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 0.0001
  },
  stepSize: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 0.001
  },
  maxLeverage: {
    type: DataTypes.INTEGER,
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 100
  },
  maintMarginRate: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 0
  },
  volume24h: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 0
  },
  quoteVolume24h: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 0
  },
  openInterest: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 0
  },
  lastPrice: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 0
  },
  priceChangePercent: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 0
  },
  highPrice24h: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 0
  },
  lowPrice24h: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true, // PERMITIR NULL para aceitar TODOS os contratos
    defaultValue: 0
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
  modelName: 'Asset',
  tableName: 'assets',
  timestamps: true,
  indexes: [
    { fields: ['symbol'] },
    { fields: ['volume24h'] },
    { fields: ['priceChangePercent'] }
  ]
});

export default Asset;