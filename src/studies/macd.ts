export class MACDStudy {
  private fastPeriod: number;
  private slowPeriod: number;
  private signalPeriod: number;
  private prices: number[] = [];
  private macdLine: number[] = [];
  private signalLine: number[] = [];
  private histogram: number[] = [];

  constructor(fastPeriod: number = 12, slowPeriod: number = 26, signalPeriod: number = 9) {
    this.fastPeriod = fastPeriod;
    this.slowPeriod = slowPeriod;
    this.signalPeriod = signalPeriod;
  }

  // Calculate Exponential Moving Average
  private calculateEMA(prices: number[], period: number): number[] {
    if (prices.length < period) return [];
    
    const multiplier = 2 / (period + 1);
    const ema: number[] = [];
    
    // First EMA value is SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[i];
    }
    ema[period - 1] = sum / period;
    
    // Calculate remaining EMA values
    for (let i = period; i < prices.length; i++) {
      ema[i] = (prices[i] * multiplier) + (ema[i - 1] * (1 - multiplier));
    }
    
    return ema;
  }

  // Add new bar data
  addBar(barData: any): void {
    const price = parseFloat(barData.Close);
    this.prices.push(price);
    
    // Keep only necessary data to prevent memory issues
    const maxLength = Math.max(this.slowPeriod, this.signalPeriod) + 100;
    if (this.prices.length > maxLength) {
      this.prices = this.prices.slice(-maxLength);
      this.macdLine = this.macdLine.slice(-maxLength);
      this.signalLine = this.signalLine.slice(-maxLength);
      this.histogram = this.histogram.slice(-maxLength);
    }
    
    this.calculate();
  }

  // Calculate MACD values
  private calculate(): void {
    if (this.prices.length < this.slowPeriod) {
      return;
    }

    // Calculate EMAs
    const fastEMA = this.calculateEMA(this.prices, this.fastPeriod);
    const slowEMA = this.calculateEMA(this.prices, this.slowPeriod);

    // Calculate MACD line (fast EMA - slow EMA)
    this.macdLine = [];
    for (let i = this.slowPeriod - 1; i < this.prices.length; i++) {
      if (fastEMA[i] !== undefined && slowEMA[i] !== undefined) {
        this.macdLine.push(fastEMA[i] - slowEMA[i]);
      }
    }

    // Calculate Signal line (EMA of MACD line)
    if (this.macdLine.length >= this.signalPeriod) {
      const signalEMA = this.calculateEMA(this.macdLine, this.signalPeriod);
      this.signalLine = signalEMA;

      // Calculate Histogram (MACD - Signal)
      this.histogram = [];
      for (let i = 0; i < this.signalLine.length; i++) {
        if (this.macdLine[i] !== undefined && this.signalLine[i] !== undefined) {
          this.histogram.push(this.macdLine[i] - this.signalLine[i]);
        }
      }
    }
  }

  // Get current MACD values
  getCurrentValues(): any {
    const macdLength = this.macdLine.length;
    const signalLength = this.signalLine.length;
    const histogramLength = this.histogram.length;

    if (macdLength === 0) return null;

    return {
      macd: macdLength > 0 ? this.macdLine[macdLength - 1] : null,
      signal: signalLength > 0 ? this.signalLine[signalLength - 1] : null,
      histogram: histogramLength > 0 ? this.histogram[histogramLength - 1] : null,
      crossover: this.detectCrossover()
    };
  }

  // Detect MACD crossovers
  private detectCrossover(): string {
    if (this.macdLine.length < 2 || this.signalLine.length < 2) {
      return 'none';
    }

    const currentMACD = this.macdLine[this.macdLine.length - 1];
    const prevMACD = this.macdLine[this.macdLine.length - 2];
    const currentSignal = this.signalLine[this.signalLine.length - 1];
    const prevSignal = this.signalLine[this.signalLine.length - 2];

    // Bullish crossover: MACD crosses above Signal
    if (prevMACD <= prevSignal && currentMACD > currentSignal) {
      return 'bullish';
    }

    // Bearish crossover: MACD crosses below Signal
    if (prevMACD >= prevSignal && currentMACD < currentSignal) {
      return 'bearish';
    }

    return 'none';
  }

  // Get all MACD history
  getAllValues(): any {
    return {
      macdLine: [...this.macdLine],
      signalLine: [...this.signalLine],
      histogram: [...this.histogram]
    };
  }
}

// Example usage with your trading data format
function processTradingData() {
  const macd = new MACDStudy(12, 26, 9); // Standard MACD parameters

  // Example bar data in your format
  const sampleBars = [
    {
      "High": "217.32",
      "Low": "216.2",
      "Open": "217.32",
      "Close": "217",
      "TimeStamp": "2020-11-12T17:00:00Z",
      "TotalVolume": "807033",
      "DownTicks": 2091,
      "DownVolume": 396976,
      "OpenInterest": "0",
      "IsRealtime": false,
      "IsEndOfHistory": false,
      "TotalTicks": 4296,
      "UnchangedTicks": 0,
      "UnchangedVolume": 0,
      "UpTicks": 2205,
      "UpVolume": 410057,
      "Epoch": 1605200400000,
      "BarStatus": "Open"
    },
    // Add more bars here...
  ];

  // Process each bar
  sampleBars.forEach((bar, index) => {
    macd.addBar(bar);
    
    const values = macd.getCurrentValues();
    if (values) {
      console.log(`Bar ${index + 1}:`);
      console.log(`  MACD: ${values.macd?.toFixed(4) || 'N/A'}`);
      console.log(`  Signal: ${values.signal?.toFixed(4) || 'N/A'}`);
      console.log(`  Histogram: ${values.histogram?.toFixed(4) || 'N/A'}`);
      console.log(`  Crossover: ${values.crossover}`);
      console.log('---');
    }
  });

  return macd;
}

// Real-time processing function
function processRealTimeBar(macd, barData) {
  macd.addBar(barData);
  const values = macd.getCurrentValues();
  
  if (values) {
    // Handle MACD signals
    if (values.crossover === 'bullish') {
      console.log('🟢 BULLISH CROSSOVER DETECTED!');
      // Execute buy signal logic here
    } else if (values.crossover === 'bearish') {
      console.log('🔴 BEARISH CROSSOVER DETECTED!');
      // Execute sell signal logic here
    }
    
    return values;
  }
  
  return null;
}

// Export functions for use in other modules
export {
  processTradingData,
  processRealTimeBar
};

// Example usage
if (require.main === module) {
  processTradingData();
}