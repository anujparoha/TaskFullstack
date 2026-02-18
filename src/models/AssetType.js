const mongoose = require('mongoose');

/**
 * AssetType defines the currency/credits available in the system.
 * e.g., "Gold Coins", "Diamonds", "Loyalty Points"
 */
const assetTypeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      // e.g., "GOLD", "DIAMOND", "POINTS"
    },
    name: {
      type: String,
      required: true,
      trim: true,
      // e.g., "Gold Coins"
    },
    description: {
      type: String,
      default: '',
    },
    decimalPlaces: {
      type: Number,
      default: 0, // Most virtual currencies are whole numbers
      min: 0,
      max: 8,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('AssetType', assetTypeSchema);
