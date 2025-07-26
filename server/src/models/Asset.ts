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

interface AssetCreationAttributes extends Optional<AssetAttributes, 'id'> {}

class Asset extends Model<AssetAttributes, AssetCreationAttributes> implements AssetAttributes {
  public id!: number;
  public symbol!: string;
  public name!: string;
  public baseCurrency!: string;
  public quoteCurrency!: string;
  public status!: string;
  public minQty!: number;
  public maxQty!: number;
  public tickSize!: number;
  public stepSize!: number;
  public maxLeverage!: number;
  public maintMarginRate!: number;
  public volume24h!: number;
  public quoteVolume24h!: number;
  public openInterest!: number;
  public lastPrice!: number;
  public priceChangePercent!: number;
  public highPrice24h!: number;
  public lowPrice24h!: number;
  public readonly updatedAt!: Date;
  public readonly createdAt!: Date;
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
    allowNull: false
  },
  quoteCurrency: {
    type: DataTypes.STRING,
    allowNull: false
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'TRADING'
  },
  minQty: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false
  },
  maxQty: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false
  },
  tickSize: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false
  },
  stepSize: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false
  },
  maxLeverage: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  maintMarginRate: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: false
  },
  volume24h: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false,
    defaultValue: 0
  },
  quoteVolume24h: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false,
    defaultValue: 0
  },
  openInterest: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false,
    defaultValue: 0
  },
  lastPrice: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false,
    defaultValue: 0
  },
  priceChangePercent: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0
  },
  highPrice24h: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false,
    defaultValue: 0
  },
  lowPrice24h: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false,
    defaultValue: 0
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