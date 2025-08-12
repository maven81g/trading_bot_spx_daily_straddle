// Generate and save SPX sample data files
// Run with: npx ts-node src/testing/sample-data/generate-spx-data.ts

import fs from 'fs';
import path from 'path';
import { TestDataGenerator, TestScenario } from '../test-data-generator';
import { Bar } from '@/types/tradestation';

interface SPXDataFile {
  description: string;
  symbol: string;
  date: string;
  timeframe: string;
  scenario: string;
  bars: Bar[];
  metadata?: any;
}

class SPXDataFileGenerator {
  private outputDir: string;

  constructor() {
    this.outputDir = path.join(__dirname);
    
    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Generate all sample data files
   */
  async generateAllSampleData(): Promise<void> {
    console.log('🔄 Generating SPX sample data files...');

    // Generate test scenarios
    const scenarios = TestDataGenerator.getAllTestScenarios();
    
    for (const scenario of scenarios) {
      await this.saveScenarioData(scenario);
    }

    // Generate realistic intraday data
    await this.generateRealisticIntradayFiles();
    
    // Generate CSV versions for easy viewing
    await this.generateCSVFiles();

    console.log('✅ All SPX sample data files generated successfully!');
  }

  /**
   * Save a test scenario as JSON file
   */
  private async saveScenarioData(scenario: TestScenario): Promise<void> {
    const filename = this.sanitizeFilename(scenario.name);
    const filepath = path.join(this.outputDir, `${filename}.json`);

    const dataFile: SPXDataFile = {
      description: scenario.description,
      symbol: '$SPXW.X',
      date: new Date().toISOString().split('T')[0],
      timeframe: '1min',
      scenario: scenario.name,
      bars: scenario.bars,
      metadata: {
        startPrice: scenario.startPrice,
        expectedSignals: scenario.expectedSignals,
        totalBars: scenario.bars.length,
        priceRange: {
          min: Math.min(...scenario.bars.map(b => parseFloat(b.Low))),
          max: Math.max(...scenario.bars.map(b => parseFloat(b.High)))
        }
      }
    };

    fs.writeFileSync(filepath, JSON.stringify(dataFile, null, 2));
    console.log(`📄 Generated: ${filename}.json (${scenario.bars.length} bars)`);
  }

  /**
   * Generate realistic intraday data files for different dates
   */
  private async generateRealisticIntradayFiles(): Promise<void> {
    const dates = [
      new Date('2024-01-15'),
      new Date('2024-01-16'), 
      new Date('2024-01-17'),
      new Date('2024-01-18'),
      new Date('2024-01-19')
    ];

    for (const date of dates) {
      const bars = TestDataGenerator.generateRealisticIntradayData(date);
      const filename = `realistic-intraday-${date.toISOString().split('T')[0]}`;
      const filepath = path.join(this.outputDir, `${filename}.json`);

      const dataFile: SPXDataFile = {
        description: `Realistic SPX intraday data for ${date.toDateString()}`,
        symbol: '$SPXW.X',
        date: date.toISOString().split('T')[0],
        timeframe: '1min',
        scenario: 'Realistic Intraday',
        bars,
        metadata: {
          totalBars: bars.length,
          tradingHours: '09:30-16:00 EST',
          priceRange: {
            min: Math.min(...bars.map(b => parseFloat(b.Low))),
            max: Math.max(...bars.map(b => parseFloat(b.High))),
            open: parseFloat(bars[0].Open),
            close: parseFloat(bars[bars.length - 1].Close)
          },
          totalVolume: bars.reduce((sum, b) => sum + parseInt(b.TotalVolume), 0)
        }
      };

      fs.writeFileSync(filepath, JSON.stringify(dataFile, null, 2));
      console.log(`📄 Generated: ${filename}.json (${bars.length} bars)`);
    }
  }

  /**
   * Generate CSV files for easy viewing in Excel/Google Sheets
   */
  private async generateCSVFiles(): Promise<void> {
    const jsonFiles = fs.readdirSync(this.outputDir).filter(f => f.endsWith('.json'));

    for (const jsonFile of jsonFiles) {
      const jsonPath = path.join(this.outputDir, jsonFile);
      const csvPath = path.join(this.outputDir, jsonFile.replace('.json', '.csv'));
      
      try {
        const data: SPXDataFile = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const csvContent = this.convertToCSV(data.bars);
        
        fs.writeFileSync(csvPath, csvContent);
        console.log(`📊 Generated CSV: ${jsonFile.replace('.json', '.csv')}`);
      } catch (error) {
        console.warn(`⚠️  Failed to generate CSV for ${jsonFile}:`, error);
      }
    }
  }

  /**
   * Convert bars data to CSV format
   */
  private convertToCSV(bars: Bar[]): string {
    const headers = [
      'TimeStamp',
      'Open', 
      'High',
      'Low',
      'Close',
      'Volume',
      'UpTicks',
      'DownTicks'
    ];

    const csvRows = [headers.join(',')];

    for (const bar of bars) {
      const row = [
        bar.TimeStamp,
        bar.Open,
        bar.High, 
        bar.Low,
        bar.Close,
        bar.TotalVolume,
        bar.UpTicks.toString(),
        bar.DownTicks.toString()
      ];
      csvRows.push(row.join(','));
    }

    return csvRows.join('\n');
  }

  /**
   * Create a sample data loader utility
   */
  async generateSampleDataLoader(): Promise<void> {
    const loaderCode = `// SPX Sample Data Loader
// Use this to load sample data in your tests

import fs from 'fs';
import path from 'path';
import { Bar } from '@/types/tradestation';

export interface SPXSampleData {
  description: string;
  symbol: string;
  date: string;
  timeframe: string;
  scenario: string;
  bars: Bar[];
  metadata?: any;
}

export class SPXSampleDataLoader {
  private static dataDir = __dirname;

  /**
   * Load a specific sample data file
   */
  static loadSampleData(filename: string): SPXSampleData {
    const filepath = path.join(this.dataDir, \`\${filename}.json\`);
    
    if (!fs.existsSync(filepath)) {
      throw new Error(\`Sample data file not found: \${filename}.json\`);
    }

    const data = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(data) as SPXSampleData;
  }

  /**
   * Get list of available sample data files
   */
  static getAvailableDataFiles(): string[] {
    return fs.readdirSync(this.dataDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  }

  /**
   * Load MACD bullish scenario data
   */
  static loadMACDBullishScenario(): SPXSampleData {
    return this.loadSampleData('macd-bullish-scenario');
  }

  /**
   * Load realistic intraday data for a specific date
   */
  static loadRealisticIntraday(date: string): SPXSampleData {
    return this.loadSampleData(\`realistic-intraday-\${date}\`);
  }

  /**
   * Load false breakout scenario data
   */
  static loadFalseBreakoutScenario(): SPXSampleData {
    return this.loadSampleData('false-breakout-scenario');
  }
}

// Example usage:
// const data = SPXSampleDataLoader.loadMACDBullishScenario();
// console.log(\`Loaded \${data.bars.length} bars for scenario: \${data.scenario}\`);
`;

    const loaderPath = path.join(this.outputDir, 'spx-sample-data-loader.ts');
    fs.writeFileSync(loaderPath, loaderCode);
    console.log('🔧 Generated: spx-sample-data-loader.ts');
  }

  private sanitizeFilename(name: string): string {
    return name.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  }
}

// Execute if run directly
async function main() {
  const generator = new SPXDataFileGenerator();
  
  try {
    await generator.generateAllSampleData();
    await generator.generateSampleDataLoader();
    
    console.log('\n🎉 SPX sample data generation completed!');
    console.log('\nGenerated files:');
    console.log('📁 JSON files: Full data with metadata');
    console.log('📊 CSV files: For viewing in Excel/Sheets');
    console.log('🔧 Loader utility: For easy data access in tests');
    
  } catch (error) {
    console.error('❌ Error generating sample data:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { SPXDataFileGenerator };