// post-mover-alerts.js  (v2 — Yahoo Finance edition, no API key needed)
// DegenTrader mover alerts:
//   - Premarket movers (±3%, Yahoo preMarketChangePercent)
//   - Intraday movers (±3%, regularMarketChangePercent)
//   - Post-market movers (±3%, postMarketChangePercent)
//   - New 52-week highs (ratcheting watermark stored in Postgres)
//   - Down 30% from 52-week high
//
// Railway cron: */15 * * * *  (script decides internally what to run based on ET time)
// Env vars: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET, DATABASE_URL
// Optional: RUN_NOW=premarket|intraday|postmarket  (forces a scan for testing)
// Requires Node 22+ (yahoo-finance2 v4)
 
import { TwitterApi } from 'twitter-api-v2';
import pg from 'pg';
import YahooFinance from 'yahoo-finance2';
 
const { Client } = pg;
const yahooFinance = new YahooFinance();
 
// ===================== CONFIG =====================
const MOVE_THRESHOLD = 3;        // % intraday move to trigger alert
const EXTENDED_THRESHOLD = 3;    // % pre/post-market move to trigger alert
const DRAWDOWN_THRESHOLD = 30;   // % below watermark high
const MAX_ALERTS_PER_SCAN = 3;   // hard cap on tweets per scan
const MIN_PRICE = 5;             // ignore stocks under $5
const QUOTE_CHUNK_SIZE = 200;    // symbols per Yahoo request
const CHUNK_DELAY_MS = 750;      // polite pause between chunks
 
// Cooldowns (hours) per alert type per symbol
const COOLDOWN_HOURS = {
  premarket_up: 20,
  premarket_down: 20,
  move_up: 20,
  move_down: 20,
  postmarket_up: 20,
  postmarket_down: 20,
  new_high: 168,   // once a week per symbol
  drawdown: 720,   // once a month per symbol
};
 
// ============ TICKER POOL ============
// PASTE YOUR 561-TICKER ARRAY FROM post-chart-game.js HERE.
const TICKERS = [
  { symbol: 'MMM', name: '3M', region: 'Industrials', famous: false },
  { symbol: 'AOS', name: 'A. O. Smith', region: 'Industrials', famous: false },
  { symbol: 'ABT', name: 'Abbott Laboratories', region: 'Health Care', famous: false },
  { symbol: 'ABBV', name: 'AbbVie', region: 'Health Care', famous: false },
  { symbol: 'ACN', name: 'Accenture', region: 'Information Technology', famous: false },
  { symbol: 'ADBE', name: 'Adobe', region: 'Information Technology', famous: true },
  { symbol: 'AMD', name: 'Advanced Micro Devices', region: 'Information Technology', famous: true },
  { symbol: 'AES', name: 'AES', region: 'Utilities', famous: false },
  { symbol: 'AFL', name: 'Aflac', region: 'Financials', famous: false },
  { symbol: 'A', name: 'Agilent', region: 'Health Care', famous: false },
  { symbol: 'APD', name: 'Air Products', region: 'Materials', famous: false },
  { symbol: 'ABNB', name: 'Airbnb', region: 'Consumer Discretionary', famous: true },
  { symbol: 'AKAM', name: 'Akamai', region: 'Information Technology', famous: false },
  { symbol: 'ALB', name: 'Albemarle', region: 'Materials', famous: false },
  { symbol: 'ARE', name: 'Alexandria Real Estate Eq', region: 'Real Estate', famous: false },
  { symbol: 'ALGN', name: 'Align', region: 'Health Care', famous: false },
  { symbol: 'ALLE', name: 'Allegion', region: 'Industrials', famous: false },
  { symbol: 'LNT', name: 'Alliant Energy', region: 'Utilities', famous: false },
  { symbol: 'ALL', name: 'Allstate', region: 'Financials', famous: false },
  { symbol: 'GOOGL', name: 'Alphabet', region: 'Communication Services', famous: true },
  { symbol: 'GOOG', name: 'Alphabet', region: 'Communication Services', famous: true },
  { symbol: 'MO', name: 'Altria', region: 'Consumer Staples', famous: true },
  { symbol: 'AMZN', name: 'Amazon', region: 'Consumer Discretionary', famous: true },
  { symbol: 'AMCR', name: 'Amcor', region: 'Materials', famous: false },
  { symbol: 'AEE', name: 'Ameren', region: 'Utilities', famous: false },
  { symbol: 'AEP', name: 'American Electric Power', region: 'Utilities', famous: false },
  { symbol: 'AXP', name: 'American Express', region: 'Financials', famous: true },
  { symbol: 'AIG', name: 'American International', region: 'Financials', famous: false },
  { symbol: 'AMT', name: 'American Tower', region: 'Real Estate', famous: false },
  { symbol: 'AWK', name: 'American Water Works', region: 'Utilities', famous: false },
  { symbol: 'AMP', name: 'Ameriprise Financial', region: 'Financials', famous: false },
  { symbol: 'AME', name: 'Ametek', region: 'Industrials', famous: false },
  { symbol: 'AMGN', name: 'Amgen', region: 'Health Care', famous: false },
  { symbol: 'APH', name: 'Amphenol', region: 'Information Technology', famous: false },
  { symbol: 'ADI', name: 'Analog Devices', region: 'Information Technology', famous: false },
  { symbol: 'AON', name: 'Aon', region: 'Financials', famous: false },
  { symbol: 'APA', name: 'APA', region: 'Energy', famous: false },
  { symbol: 'APO', name: 'Apollo Global Management', region: 'Financials', famous: false },
  { symbol: 'AAPL', name: 'Apple', region: 'Information Technology', famous: true },
  { symbol: 'AMAT', name: 'Applied Materials', region: 'Information Technology', famous: false },
  { symbol: 'APP', name: 'AppLovin', region: 'Information Technology', famous: false },
  { symbol: 'APTV', name: 'Aptiv', region: 'Consumer Discretionary', famous: false },
  { symbol: 'ACGL', name: 'Arch Capital', region: 'Financials', famous: false },
  { symbol: 'ADM', name: 'Archer Daniels Midland', region: 'Consumer Staples', famous: false },
  { symbol: 'ARES', name: 'Ares Management', region: 'Financials', famous: false },
  { symbol: 'ANET', name: 'Arista Networks', region: 'Information Technology', famous: false },
  { symbol: 'AJG', name: 'Arthur J. Gallagher &', region: 'Financials', famous: false },
  { symbol: 'AIZ', name: 'Assurant', region: 'Financials', famous: false },
  { symbol: 'T', name: 'AT&T', region: 'Communication Services', famous: true },
  { symbol: 'ATO', name: 'Atmos Energy', region: 'Utilities', famous: false },
  { symbol: 'ADSK', name: 'Autodesk', region: 'Information Technology', famous: false },
  { symbol: 'ADP', name: 'Automatic Data Processing', region: 'Industrials', famous: false },
  { symbol: 'AZO', name: 'AutoZone', region: 'Consumer Discretionary', famous: false },
  { symbol: 'AVB', name: 'AvalonBay Communities', region: 'Real Estate', famous: false },
  { symbol: 'AVY', name: 'Avery Dennison', region: 'Materials', famous: false },
  { symbol: 'AXON', name: 'Axon Enterprise', region: 'Industrials', famous: false },
  { symbol: 'BKR', name: 'Baker Hughes', region: 'Energy', famous: false },
  { symbol: 'BALL', name: 'Ball', region: 'Materials', famous: false },
  { symbol: 'BAC', name: 'Bank of America', region: 'Financials', famous: true },
  { symbol: 'BAX', name: 'Baxter', region: 'Health Care', famous: false },
  { symbol: 'BDX', name: 'Becton Dickinson', region: 'Health Care', famous: false },
  { symbol: 'BRK-B', name: 'Berkshire Hathaway', region: 'Financials', famous: true },
  { symbol: 'BBY', name: 'Best Buy', region: 'Consumer Discretionary', famous: false },
  { symbol: 'TECH', name: 'Bio-Techne', region: 'Health Care', famous: false },
  { symbol: 'BIIB', name: 'Biogen', region: 'Health Care', famous: false },
  { symbol: 'BLK', name: 'BlackRock', region: 'Financials', famous: false },
  { symbol: 'BX', name: 'Blackstone', region: 'Financials', famous: false },
  { symbol: 'XYZ', name: 'Block', region: 'Financials', famous: false },
  { symbol: 'BNY', name: 'BNY Mellon', region: 'Financials', famous: false },
  { symbol: 'BA', name: 'Boeing', region: 'Industrials', famous: true },
  { symbol: 'BKNG', name: 'Booking', region: 'Consumer Discretionary', famous: false },
  { symbol: 'BSX', name: 'Boston Scientific', region: 'Health Care', famous: false },
  { symbol: 'BMY', name: 'Bristol Myers Squibb', region: 'Health Care', famous: false },
  { symbol: 'AVGO', name: 'Broadcom', region: 'Information Technology', famous: false },
  { symbol: 'BR', name: 'Broadridge Financial Solu', region: 'Industrials', famous: false },
  { symbol: 'BRO', name: 'Brown & Brown', region: 'Financials', famous: false },
  { symbol: 'BF-B', name: 'Brown–Forman', region: 'Consumer Staples', famous: false },
  { symbol: 'BLDR', name: 'Builders FirstSource', region: 'Industrials', famous: false },
  { symbol: 'BG', name: 'Bunge Global', region: 'Consumer Staples', famous: false },
  { symbol: 'BXP', name: 'BXP', region: 'Real Estate', famous: false },
  { symbol: 'CHRW', name: 'C.H. Robinson', region: 'Industrials', famous: false },
  { symbol: 'CDNS', name: 'Cadence Design Systems', region: 'Information Technology', famous: false },
  { symbol: 'CPT', name: 'Camden Property Trust', region: 'Real Estate', famous: false },
  { symbol: 'COF', name: 'Capital One', region: 'Financials', famous: false },
  { symbol: 'CAH', name: 'Cardinal Health', region: 'Health Care', famous: false },
  { symbol: 'CCL', name: 'Carnival', region: 'Consumer Discretionary', famous: true },
  { symbol: 'CARR', name: 'Carrier Global', region: 'Industrials', famous: false },
  { symbol: 'CVNA', name: 'Carvana', region: 'Consumer Discretionary', famous: false },
  { symbol: 'CASY', name: 'Casey\'s', region: 'Consumer Staples', famous: false },
  { symbol: 'CAT', name: 'Caterpillar', region: 'Industrials', famous: true },
  { symbol: 'CBOE', name: 'Cboe Global Markets', region: 'Financials', famous: false },
  { symbol: 'CBRE', name: 'CBRE', region: 'Real Estate', famous: false },
  { symbol: 'CDW', name: 'CDW', region: 'Information Technology', famous: false },
  { symbol: 'COR', name: 'Cencora', region: 'Health Care', famous: false },
  { symbol: 'CNC', name: 'Centene', region: 'Health Care', famous: false },
  { symbol: 'CNP', name: 'CenterPoint Energy', region: 'Utilities', famous: false },
  { symbol: 'CF', name: 'CF Industries', region: 'Materials', famous: false },
  { symbol: 'CRL', name: 'Charles River Laboratorie', region: 'Health Care', famous: false },
  { symbol: 'SCHW', name: 'Charles Schwab', region: 'Financials', famous: false },
  { symbol: 'CHTR', name: 'Charter Communications', region: 'Communication Services', famous: false },
  { symbol: 'CVX', name: 'Chevron', region: 'Energy', famous: true },
  { symbol: 'CMG', name: 'Chipotle Mexican Grill', region: 'Consumer Discretionary', famous: true },
  { symbol: 'CB', name: 'Chubb', region: 'Financials', famous: false },
  { symbol: 'CHD', name: 'Church & Dwight', region: 'Consumer Staples', famous: false },
  { symbol: 'CIEN', name: 'Ciena', region: 'Information Technology', famous: false },
  { symbol: 'CI', name: 'Cigna', region: 'Health Care', famous: false },
  { symbol: 'CINF', name: 'Cincinnati Financial', region: 'Financials', famous: false },
  { symbol: 'CTAS', name: 'Cintas', region: 'Industrials', famous: false },
  { symbol: 'CSCO', name: 'Cisco', region: 'Information Technology', famous: false },
  { symbol: 'C', name: 'Citigroup', region: 'Financials', famous: true },
  { symbol: 'CFG', name: 'Citizens Financial', region: 'Financials', famous: false },
  { symbol: 'CLX', name: 'Clorox', region: 'Consumer Staples', famous: false },
  { symbol: 'CME', name: 'CME', region: 'Financials', famous: false },
  { symbol: 'CMS', name: 'CMS Energy', region: 'Utilities', famous: false },
  { symbol: 'KO', name: 'Coca-Cola Company (The)', region: 'Consumer Staples', famous: true },
  { symbol: 'CTSH', name: 'Cognizant', region: 'Information Technology', famous: false },
  { symbol: 'COHR', name: 'Coherent', region: 'Information Technology', famous: false },
  { symbol: 'COIN', name: 'Coinbase', region: 'Financials', famous: true },
  { symbol: 'CL', name: 'Colgate-Palmolive', region: 'Consumer Staples', famous: true },
  { symbol: 'CMCSA', name: 'Comcast', region: 'Communication Services', famous: true },
  { symbol: 'FIX', name: 'Comfort Systems USA', region: 'Industrials', famous: false },
  { symbol: 'COP', name: 'ConocoPhillips', region: 'Energy', famous: false },
  { symbol: 'ED', name: 'Consolidated Edison', region: 'Utilities', famous: false },
  { symbol: 'STZ', name: 'Constellation Brands', region: 'Consumer Staples', famous: false },
  { symbol: 'CEG', name: 'Constellation Energy', region: 'Utilities', famous: false },
  { symbol: 'COO', name: 'Cooper Companies (The)', region: 'Health Care', famous: false },
  { symbol: 'CPRT', name: 'Copart', region: 'Industrials', famous: false },
  { symbol: 'GLW', name: 'Corning', region: 'Information Technology', famous: false },
  { symbol: 'CPAY', name: 'Corpay', region: 'Financials', famous: false },
  { symbol: 'CTVA', name: 'Corteva', region: 'Materials', famous: false },
  { symbol: 'CSGP', name: 'CoStar', region: 'Real Estate', famous: false },
  { symbol: 'COST', name: 'Costco', region: 'Consumer Staples', famous: true },
  { symbol: 'CRH', name: 'CRH', region: 'Materials', famous: false },
  { symbol: 'CRWD', name: 'CrowdStrike', region: 'Information Technology', famous: false },
  { symbol: 'CCI', name: 'Crown Castle', region: 'Real Estate', famous: false },
  { symbol: 'CSX', name: 'CSX', region: 'Industrials', famous: false },
  { symbol: 'CMI', name: 'Cummins', region: 'Industrials', famous: false },
  { symbol: 'CVS', name: 'CVS Health', region: 'Health Care', famous: true },
  { symbol: 'DHR', name: 'Danaher', region: 'Health Care', famous: false },
  { symbol: 'DRI', name: 'Darden Restaurants', region: 'Consumer Discretionary', famous: false },
  { symbol: 'DDOG', name: 'Datadog', region: 'Information Technology', famous: false },
  { symbol: 'DVA', name: 'DaVita', region: 'Health Care', famous: false },
  { symbol: 'DECK', name: 'Deckers Brands', region: 'Consumer Discretionary', famous: false },
  { symbol: 'DE', name: 'Deere &', region: 'Industrials', famous: false },
  { symbol: 'DELL', name: 'Dell', region: 'Information Technology', famous: false },
  { symbol: 'DAL', name: 'Delta Air Lines', region: 'Industrials', famous: true },
  { symbol: 'DVN', name: 'Devon Energy', region: 'Energy', famous: false },
  { symbol: 'DXCM', name: 'Dexcom', region: 'Health Care', famous: false },
  { symbol: 'FANG', name: 'Diamondback Energy', region: 'Energy', famous: false },
  { symbol: 'DLR', name: 'Digital Realty', region: 'Real Estate', famous: false },
  { symbol: 'DG', name: 'Dollar General', region: 'Consumer Staples', famous: false },
  { symbol: 'DLTR', name: 'Dollar Tree', region: 'Consumer Staples', famous: false },
  { symbol: 'D', name: 'Dominion Energy', region: 'Utilities', famous: false },
  { symbol: 'DPZ', name: 'Domino\'s', region: 'Consumer Discretionary', famous: true },
  { symbol: 'DASH', name: 'DoorDash', region: 'Consumer Discretionary', famous: true },
  { symbol: 'DOV', name: 'Dover', region: 'Industrials', famous: false },
  { symbol: 'DOW', name: 'Dow', region: 'Materials', famous: false },
  { symbol: 'DHI', name: 'D. R. Horton', region: 'Consumer Discretionary', famous: false },
  { symbol: 'DTE', name: 'DTE Energy', region: 'Utilities', famous: false },
  { symbol: 'DUK', name: 'Duke Energy', region: 'Utilities', famous: false },
  { symbol: 'DD', name: 'DuPont', region: 'Materials', famous: false },
  { symbol: 'ETN', name: 'Eaton', region: 'Industrials', famous: false },
  { symbol: 'EBAY', name: 'eBay', region: 'Consumer Discretionary', famous: true },
  { symbol: 'ECHO', name: 'EchoStar', region: 'Communication Services', famous: false },
  { symbol: 'ECL', name: 'Ecolab', region: 'Materials', famous: false },
  { symbol: 'EIX', name: 'Edison', region: 'Utilities', famous: false },
  { symbol: 'EW', name: 'Edwards Lifesciences', region: 'Health Care', famous: false },
  { symbol: 'EA', name: 'Electronic Arts', region: 'Communication Services', famous: true },
  { symbol: 'ELV', name: 'Elevance Health', region: 'Health Care', famous: false },
  { symbol: 'EME', name: 'Emcor', region: 'Industrials', famous: false },
  { symbol: 'EMR', name: 'Emerson Electric', region: 'Industrials', famous: false },
  { symbol: 'ETR', name: 'Entergy', region: 'Utilities', famous: false },
  { symbol: 'EOG', name: 'EOG Resources', region: 'Energy', famous: false },
  { symbol: 'EQT', name: 'EQT', region: 'Energy', famous: false },
  { symbol: 'EFX', name: 'Equifax', region: 'Industrials', famous: false },
  { symbol: 'EQIX', name: 'Equinix', region: 'Real Estate', famous: false },
  { symbol: 'EQR', name: 'Equity Residential', region: 'Real Estate', famous: false },
  { symbol: 'ERIE', name: 'Erie Indemnity', region: 'Financials', famous: false },
  { symbol: 'ESS', name: 'Essex Property Trust', region: 'Real Estate', famous: false },
  { symbol: 'EL', name: 'Estée Lauder Companies (T', region: 'Consumer Staples', famous: false },
  { symbol: 'EG', name: 'Everest', region: 'Financials', famous: false },
  { symbol: 'EVRG', name: 'Evergy', region: 'Utilities', famous: false },
  { symbol: 'ES', name: 'Eversource Energy', region: 'Utilities', famous: false },
  { symbol: 'EXC', name: 'Exelon', region: 'Utilities', famous: false },
  { symbol: 'EXE', name: 'Expand Energy', region: 'Energy', famous: false },
  { symbol: 'EXPE', name: 'Expedia', region: 'Consumer Discretionary', famous: true },
  { symbol: 'EXPD', name: 'Expeditors', region: 'Industrials', famous: false },
  { symbol: 'EXR', name: 'Extra Space Storage', region: 'Real Estate', famous: false },
  { symbol: 'XOM', name: 'ExxonMobil', region: 'Energy', famous: true },
  { symbol: 'FFIV', name: 'F5', region: 'Information Technology', famous: false },
  { symbol: 'FDS', name: 'FactSet', region: 'Financials', famous: false },
  { symbol: 'FICO', name: 'Fair Isaac', region: 'Information Technology', famous: false },
  { symbol: 'FAST', name: 'Fastenal', region: 'Industrials', famous: false },
  { symbol: 'FRT', name: 'Federal Realty Investment', region: 'Real Estate', famous: false },
  { symbol: 'FDX', name: 'FedEx', region: 'Industrials', famous: false },
  { symbol: 'FDXF', name: 'FedEx Freight', region: 'Industrials', famous: false },
  { symbol: 'FIS', name: 'Fidelity National Informa', region: 'Financials', famous: false },
  { symbol: 'FITB', name: 'Fifth Third Bancorp', region: 'Financials', famous: false },
  { symbol: 'FSLR', name: 'First Solar', region: 'Information Technology', famous: false },
  { symbol: 'FE', name: 'FirstEnergy', region: 'Utilities', famous: false },
  { symbol: 'FISV', name: 'Fiserv', region: 'Financials', famous: false },
  { symbol: 'FLEX', name: 'Flex', region: 'Information Technology', famous: false },
  { symbol: 'F', name: 'Ford Motor', region: 'Consumer Discretionary', famous: true },
  { symbol: 'FTNT', name: 'Fortinet', region: 'Information Technology', famous: false },
  { symbol: 'FTV', name: 'Fortive', region: 'Industrials', famous: false },
  { symbol: 'FOXA', name: 'Fox', region: 'Communication Services', famous: false },
  { symbol: 'FOX', name: 'Fox', region: 'Communication Services', famous: true },
  { symbol: 'BEN', name: 'Franklin Resources', region: 'Financials', famous: false },
  { symbol: 'FCX', name: 'Freeport-McMoRan', region: 'Materials', famous: false },
  { symbol: 'GRMN', name: 'Garmin', region: 'Consumer Discretionary', famous: false },
  { symbol: 'IT', name: 'Gartner', region: 'Information Technology', famous: false },
  { symbol: 'GE', name: 'GE Aerospace', region: 'Industrials', famous: true },
  { symbol: 'GEHC', name: 'GE HealthCare', region: 'Health Care', famous: false },
  { symbol: 'GEV', name: 'GE Vernova', region: 'Industrials', famous: false },
  { symbol: 'GEN', name: 'Gen Digital', region: 'Information Technology', famous: false },
  { symbol: 'GNRC', name: 'Generac', region: 'Industrials', famous: false },
  { symbol: 'GD', name: 'General Dynamics', region: 'Industrials', famous: false },
  { symbol: 'GIS', name: 'General Mills', region: 'Consumer Staples', famous: true },
  { symbol: 'GM', name: 'General Motors', region: 'Consumer Discretionary', famous: true },
  { symbol: 'GPC', name: 'Genuine Parts', region: 'Consumer Discretionary', famous: false },
  { symbol: 'GILD', name: 'Gilead Sciences', region: 'Health Care', famous: false },
  { symbol: 'GPN', name: 'Global Payments', region: 'Financials', famous: false },
  { symbol: 'GL', name: 'Globe Life', region: 'Financials', famous: false },
  { symbol: 'GDDY', name: 'GoDaddy', region: 'Information Technology', famous: false },
  { symbol: 'GS', name: 'Goldman Sachs', region: 'Financials', famous: true },
  { symbol: 'HAL', name: 'Halliburton', region: 'Energy', famous: false },
  { symbol: 'HIG', name: 'Hartford (The)', region: 'Financials', famous: false },
  { symbol: 'HAS', name: 'Hasbro', region: 'Consumer Discretionary', famous: false },
  { symbol: 'HCA', name: 'HCA Healthcare', region: 'Health Care', famous: false },
  { symbol: 'DOC', name: 'Healthpeak Properties', region: 'Real Estate', famous: false },
  { symbol: 'HSIC', name: 'Henry Schein', region: 'Health Care', famous: false },
  { symbol: 'HSY', name: 'Hershey Company (The)', region: 'Consumer Staples', famous: true },
  { symbol: 'HPE', name: 'Hewlett Packard Enterpris', region: 'Information Technology', famous: false },
  { symbol: 'HLT', name: 'Hilton', region: 'Consumer Discretionary', famous: true },
  { symbol: 'HD', name: 'Home Depot (The)', region: 'Consumer Discretionary', famous: true },
  { symbol: 'HONA', name: 'Honeywell Aerospace', region: 'Industrials', famous: false },
  { symbol: 'HON', name: 'Honeywell', region: 'Industrials', famous: false },
  { symbol: 'HRL', name: 'Hormel Foods', region: 'Consumer Staples', famous: false },
  { symbol: 'HST', name: 'Host Hotels & Resorts', region: 'Real Estate', famous: false },
  { symbol: 'HWM', name: 'Howmet Aerospace', region: 'Industrials', famous: false },
  { symbol: 'HPQ', name: 'HP', region: 'Information Technology', famous: false },
  { symbol: 'HUBB', name: 'Hubbell', region: 'Industrials', famous: false },
  { symbol: 'HUM', name: 'Humana', region: 'Health Care', famous: false },
  { symbol: 'HBAN', name: 'Huntington Bancshares', region: 'Financials', famous: false },
  { symbol: 'HII', name: 'Huntington Ingalls Indust', region: 'Industrials', famous: false },
  { symbol: 'IBM', name: 'IBM', region: 'Information Technology', famous: true },
  { symbol: 'IEX', name: 'IDEX', region: 'Industrials', famous: false },
  { symbol: 'IDXX', name: 'Idexx Laboratories', region: 'Health Care', famous: false },
  { symbol: 'ITW', name: 'Illinois Tool Works', region: 'Industrials', famous: false },
  { symbol: 'INCY', name: 'Incyte', region: 'Health Care', famous: false },
  { symbol: 'IR', name: 'Ingersoll Rand', region: 'Industrials', famous: false },
  { symbol: 'PODD', name: 'Insulet', region: 'Health Care', famous: false },
  { symbol: 'INTC', name: 'Intel', region: 'Information Technology', famous: true },
  { symbol: 'IBKR', name: 'Interactive Brokers', region: 'Financials', famous: false },
  { symbol: 'ICE', name: 'Intercontinental Exchange', region: 'Financials', famous: false },
  { symbol: 'IFF', name: 'International Flavors & F', region: 'Materials', famous: false },
  { symbol: 'IP', name: 'International Paper', region: 'Materials', famous: false },
  { symbol: 'INTU', name: 'Intuit', region: 'Information Technology', famous: false },
  { symbol: 'ISRG', name: 'Intuitive Surgical', region: 'Health Care', famous: false },
  { symbol: 'IVZ', name: 'Invesco', region: 'Financials', famous: false },
  { symbol: 'INVH', name: 'Invitation Homes', region: 'Real Estate', famous: false },
  { symbol: 'IQV', name: 'IQVIA', region: 'Health Care', famous: false },
  { symbol: 'IRM', name: 'Iron Mountain', region: 'Real Estate', famous: false },
  { symbol: 'JBHT', name: 'J.B. Hunt', region: 'Industrials', famous: false },
  { symbol: 'JBL', name: 'Jabil', region: 'Information Technology', famous: false },
  { symbol: 'JKHY', name: 'Jack Henry & Associates', region: 'Financials', famous: false },
  { symbol: 'J', name: 'Jacobs Solutions', region: 'Industrials', famous: false },
  { symbol: 'JNJ', name: 'Johnson & Johnson', region: 'Health Care', famous: true },
  { symbol: 'JCI', name: 'Johnson Controls', region: 'Industrials', famous: false },
  { symbol: 'JPM', name: 'JPMorgan Chase', region: 'Financials', famous: true },
  { symbol: 'KVUE', name: 'Kenvue', region: 'Consumer Staples', famous: false },
  { symbol: 'KDP', name: 'Keurig Dr Pepper', region: 'Consumer Staples', famous: false },
  { symbol: 'KEY', name: 'KeyCorp', region: 'Financials', famous: false },
  { symbol: 'KEYS', name: 'Keysight', region: 'Information Technology', famous: false },
  { symbol: 'KMB', name: 'Kimberly-Clark', region: 'Consumer Staples', famous: true },
  { symbol: 'KIM', name: 'Kimco Realty', region: 'Real Estate', famous: false },
  { symbol: 'KMI', name: 'Kinder Morgan', region: 'Energy', famous: false },
  { symbol: 'KKR', name: 'KKR &', region: 'Financials', famous: false },
  { symbol: 'KLAC', name: 'KLA', region: 'Information Technology', famous: false },
  { symbol: 'KHC', name: 'Kraft Heinz', region: 'Consumer Staples', famous: true },
  { symbol: 'KR', name: 'Kroger', region: 'Consumer Staples', famous: false },
  { symbol: 'LHX', name: 'L3Harris', region: 'Industrials', famous: false },
  { symbol: 'LH', name: 'Labcorp', region: 'Health Care', famous: false },
  { symbol: 'LRCX', name: 'Lam Research', region: 'Information Technology', famous: false },
  { symbol: 'LVS', name: 'Las Vegas Sands', region: 'Consumer Discretionary', famous: true },
  { symbol: 'LDOS', name: 'Leidos', region: 'Industrials', famous: false },
  { symbol: 'LEN', name: 'Lennar', region: 'Consumer Discretionary', famous: false },
  { symbol: 'LII', name: 'Lennox', region: 'Industrials', famous: false },
  { symbol: 'LLY', name: 'Lilly (Eli)', region: 'Health Care', famous: true },
  { symbol: 'LIN', name: 'Linde', region: 'Materials', famous: false },
  { symbol: 'LYV', name: 'Live Nation Entertainment', region: 'Communication Services', famous: true },
  { symbol: 'LMT', name: 'Lockheed Martin', region: 'Industrials', famous: false },
  { symbol: 'L', name: 'Loews', region: 'Financials', famous: false },
  { symbol: 'LOW', name: 'Lowe\'s', region: 'Consumer Discretionary', famous: true },
  { symbol: 'LULU', name: 'Lululemon Athletica', region: 'Consumer Discretionary', famous: true },
  { symbol: 'LITE', name: 'Lumentum', region: 'Information Technology', famous: false },
  { symbol: 'LYB', name: 'LyondellBasell', region: 'Materials', famous: false },
  { symbol: 'MTB', name: 'M&T Bank', region: 'Financials', famous: false },
  { symbol: 'MPC', name: 'Marathon Petroleum', region: 'Energy', famous: false },
  { symbol: 'MAR', name: 'Marriott', region: 'Consumer Discretionary', famous: true },
  { symbol: 'MRSH', name: 'Marsh McLennan', region: 'Financials', famous: false },
  { symbol: 'MLM', name: 'Martin Marietta Materials', region: 'Materials', famous: false },
  { symbol: 'MRVL', name: 'Marvell', region: 'Information Technology', famous: false },
  { symbol: 'MAS', name: 'Masco', region: 'Industrials', famous: false },
  { symbol: 'MA', name: 'Mastercard', region: 'Financials', famous: true },
  { symbol: 'MKC', name: 'McCormick &', region: 'Consumer Staples', famous: false },
  { symbol: 'MCD', name: 'McDonald\'s', region: 'Consumer Discretionary', famous: true },
  { symbol: 'MCK', name: 'McKesson', region: 'Health Care', famous: false },
  { symbol: 'MDT', name: 'Medtronic', region: 'Health Care', famous: false },
  { symbol: 'MRK', name: 'Merck &', region: 'Health Care', famous: true },
  { symbol: 'META', name: 'Meta Platforms', region: 'Communication Services', famous: true },
  { symbol: 'MET', name: 'MetLife', region: 'Financials', famous: false },
  { symbol: 'MTD', name: 'Mettler Toledo', region: 'Health Care', famous: false },
  { symbol: 'MGM', name: 'MGM Resorts', region: 'Consumer Discretionary', famous: true },
  { symbol: 'MCHP', name: 'Microchip', region: 'Information Technology', famous: false },
  { symbol: 'MU', name: 'Micron', region: 'Information Technology', famous: false },
  { symbol: 'MSFT', name: 'Microsoft', region: 'Information Technology', famous: true },
  { symbol: 'MAA', name: 'Mid-America Apartment Com', region: 'Real Estate', famous: false },
  { symbol: 'MRNA', name: 'Moderna', region: 'Health Care', famous: false },
  { symbol: 'TAP', name: 'Molson Coors Beverage', region: 'Consumer Staples', famous: false },
  { symbol: 'MDLZ', name: 'Mondelez', region: 'Consumer Staples', famous: false },
  { symbol: 'MPWR', name: 'Monolithic Power Systems', region: 'Information Technology', famous: false },
  { symbol: 'MNST', name: 'Monster Beverage', region: 'Consumer Staples', famous: false },
  { symbol: 'MCO', name: 'Moody\'s', region: 'Financials', famous: false },
  { symbol: 'MS', name: 'Morgan Stanley', region: 'Financials', famous: true },
  { symbol: 'MOS', name: 'Mosaic Company (The)', region: 'Materials', famous: false },
  { symbol: 'MSI', name: 'Motorola Solutions', region: 'Information Technology', famous: false },
  { symbol: 'MSCI', name: 'MSCI', region: 'Financials', famous: false },
  { symbol: 'NDAQ', name: 'Nasdaq', region: 'Financials', famous: false },
  { symbol: 'NTAP', name: 'NetApp', region: 'Information Technology', famous: false },
  { symbol: 'NFLX', name: 'Netflix', region: 'Communication Services', famous: true },
  { symbol: 'NEM', name: 'Newmont', region: 'Materials', famous: false },
  { symbol: 'NWSA', name: 'News', region: 'Communication Services', famous: false },
  { symbol: 'NWS', name: 'News', region: 'Communication Services', famous: false },
  { symbol: 'NEE', name: 'NextEra Energy', region: 'Utilities', famous: false },
  { symbol: 'NKE', name: 'Nike', region: 'Consumer Discretionary', famous: true },
  { symbol: 'NI', name: 'NiSource', region: 'Utilities', famous: false },
  { symbol: 'NDSN', name: 'Nordson', region: 'Industrials', famous: false },
  { symbol: 'NSC', name: 'Norfolk Southern', region: 'Industrials', famous: false },
  { symbol: 'NTRS', name: 'Northern Trust', region: 'Financials', famous: false },
  { symbol: 'NOC', name: 'Northrop Grumman', region: 'Industrials', famous: false },
  { symbol: 'NCLH', name: 'Norwegian Cruise Line', region: 'Consumer Discretionary', famous: true },
  { symbol: 'NRG', name: 'NRG Energy', region: 'Utilities', famous: false },
  { symbol: 'NUE', name: 'Nucor', region: 'Materials', famous: false },
  { symbol: 'NVDA', name: 'Nvidia', region: 'Information Technology', famous: true },
  { symbol: 'NVR', name: 'NVR', region: 'Consumer Discretionary', famous: false },
  { symbol: 'NXPI', name: 'NXP Semiconductors', region: 'Information Technology', famous: false },
  { symbol: 'ORLY', name: 'O’Reilly Automotive', region: 'Consumer Discretionary', famous: false },
  { symbol: 'OXY', name: 'Occidental Petroleum', region: 'Energy', famous: false },
  { symbol: 'ODFL', name: 'Old Dominion', region: 'Industrials', famous: false },
  { symbol: 'OMC', name: 'Omnicom', region: 'Communication Services', famous: false },
  { symbol: 'ON', name: 'ON Semiconductor', region: 'Information Technology', famous: false },
  { symbol: 'OKE', name: 'Oneok', region: 'Energy', famous: false },
  { symbol: 'ORCL', name: 'Oracle', region: 'Information Technology', famous: true },
  { symbol: 'OTIS', name: 'Otis', region: 'Industrials', famous: false },
  { symbol: 'PCAR', name: 'Paccar', region: 'Industrials', famous: false },
  { symbol: 'PKG', name: 'Packaging Corporation of ', region: 'Materials', famous: false },
  { symbol: 'PLTR', name: 'Palantir', region: 'Information Technology', famous: true },
  { symbol: 'PANW', name: 'Palo Alto Networks', region: 'Information Technology', famous: false },
  { symbol: 'PSKY', name: 'Paramount Skydance', region: 'Communication Services', famous: false },
  { symbol: 'PH', name: 'Parker Hannifin', region: 'Industrials', famous: false },
  { symbol: 'PAYX', name: 'Paychex', region: 'Industrials', famous: false },
  { symbol: 'PYPL', name: 'PayPal', region: 'Financials', famous: true },
  { symbol: 'PNR', name: 'Pentair', region: 'Industrials', famous: false },
  { symbol: 'PEP', name: 'PepsiCo', region: 'Consumer Staples', famous: true },
  { symbol: 'PFE', name: 'Pfizer', region: 'Health Care', famous: true },
  { symbol: 'PCG', name: 'PG&E', region: 'Utilities', famous: false },
  { symbol: 'PM', name: 'Philip Morris', region: 'Consumer Staples', famous: true },
  { symbol: 'PSX', name: 'Phillips 66', region: 'Energy', famous: false },
  { symbol: 'PNW', name: 'Pinnacle West Capital', region: 'Utilities', famous: false },
  { symbol: 'PNC', name: 'PNC Financial Services', region: 'Financials', famous: false },
  { symbol: 'PPG', name: 'PPG Industries', region: 'Materials', famous: false },
  { symbol: 'PPL', name: 'PPL', region: 'Utilities', famous: false },
  { symbol: 'PFG', name: 'Principal Financial', region: 'Financials', famous: false },
  { symbol: 'PG', name: 'Procter & Gamble', region: 'Consumer Staples', famous: true },
  { symbol: 'PGR', name: 'Progressive', region: 'Financials', famous: false },
  { symbol: 'PLD', name: 'Prologis', region: 'Real Estate', famous: false },
  { symbol: 'PRU', name: 'Prudential Financial', region: 'Financials', famous: false },
  { symbol: 'PEG', name: 'Public Service Enterprise', region: 'Utilities', famous: false },
  { symbol: 'PTC', name: 'PTC', region: 'Information Technology', famous: false },
  { symbol: 'PSA', name: 'Public Storage', region: 'Real Estate', famous: false },
  { symbol: 'PHM', name: 'PulteGroup', region: 'Consumer Discretionary', famous: false },
  { symbol: 'PWR', name: 'Quanta Services', region: 'Industrials', famous: false },
  { symbol: 'QCOM', name: 'Qualcomm', region: 'Information Technology', famous: false },
  { symbol: 'DGX', name: 'Quest Diagnostics', region: 'Health Care', famous: false },
  { symbol: 'Q', name: 'Qnity Electronics', region: 'Information Technology', famous: false },
  { symbol: 'RL', name: 'Ralph Lauren', region: 'Consumer Discretionary', famous: true },
  { symbol: 'RJF', name: 'Raymond James Financial', region: 'Financials', famous: false },
  { symbol: 'RTX', name: 'RTX', region: 'Industrials', famous: false },
  { symbol: 'O', name: 'Realty Income', region: 'Real Estate', famous: false },
  { symbol: 'REG', name: 'Regency Centers', region: 'Real Estate', famous: false },
  { symbol: 'REGN', name: 'Regeneron Pharmaceuticals', region: 'Health Care', famous: false },
  { symbol: 'RF', name: 'Regions Financial', region: 'Financials', famous: false },
  { symbol: 'RSG', name: 'Republic Services', region: 'Industrials', famous: false },
  { symbol: 'RMD', name: 'ResMed', region: 'Health Care', famous: false },
  { symbol: 'RVTY', name: 'Revvity', region: 'Health Care', famous: false },
  { symbol: 'HOOD', name: 'Robinhood Markets', region: 'Financials', famous: false },
  { symbol: 'ROK', name: 'Rockwell Automation', region: 'Industrials', famous: false },
  { symbol: 'ROL', name: 'Rollins', region: 'Industrials', famous: false },
  { symbol: 'ROP', name: 'Roper', region: 'Information Technology', famous: false },
  { symbol: 'ROST', name: 'Ross Stores', region: 'Consumer Discretionary', famous: false },
  { symbol: 'RCL', name: 'Royal Caribbean', region: 'Consumer Discretionary', famous: true },
  { symbol: 'SPGI', name: 'S&P Global', region: 'Financials', famous: false },
  { symbol: 'CRM', name: 'Salesforce', region: 'Information Technology', famous: true },
  { symbol: 'SNDK', name: 'Sandisk', region: 'Information Technology', famous: false },
  { symbol: 'SBAC', name: 'SBA Communications', region: 'Real Estate', famous: false },
  { symbol: 'SLB', name: 'Schlumberger', region: 'Energy', famous: false },
  { symbol: 'STX', name: 'Seagate', region: 'Information Technology', famous: false },
  { symbol: 'SRE', name: 'Sempra', region: 'Utilities', famous: false },
  { symbol: 'NOW', name: 'ServiceNow', region: 'Information Technology', famous: false },
  { symbol: 'SHW', name: 'Sherwin-Williams', region: 'Materials', famous: false },
  { symbol: 'SPG', name: 'Simon Property', region: 'Real Estate', famous: false },
  { symbol: 'SWKS', name: 'Skyworks Solutions', region: 'Information Technology', famous: false },
  { symbol: 'SJM', name: 'J.M. Smucker Company (The', region: 'Consumer Staples', famous: false },
  { symbol: 'SW', name: 'Smurfit Westrock', region: 'Materials', famous: false },
  { symbol: 'SNA', name: 'Snap-on', region: 'Industrials', famous: false },
  { symbol: 'SOLV', name: 'Solventum', region: 'Health Care', famous: false },
  { symbol: 'SO', name: 'Southern', region: 'Utilities', famous: false },
  { symbol: 'LUV', name: 'Southwest Airlines', region: 'Industrials', famous: false },
  { symbol: 'SWK', name: 'Stanley Black & Decker', region: 'Industrials', famous: false },
  { symbol: 'SBUX', name: 'Starbucks', region: 'Consumer Discretionary', famous: true },
  { symbol: 'STT', name: 'State Street', region: 'Financials', famous: false },
  { symbol: 'STLD', name: 'Steel Dynamics', region: 'Materials', famous: false },
  { symbol: 'STE', name: 'Steris', region: 'Health Care', famous: false },
  { symbol: 'SYK', name: 'Stryker', region: 'Health Care', famous: false },
  { symbol: 'SMCI', name: 'Supermicro', region: 'Information Technology', famous: false },
  { symbol: 'SYF', name: 'Synchrony Financial', region: 'Financials', famous: false },
  { symbol: 'SNPS', name: 'Synopsys', region: 'Information Technology', famous: false },
  { symbol: 'SYY', name: 'Sysco', region: 'Consumer Staples', famous: false },
  { symbol: 'TMUS', name: 'T-Mobile US', region: 'Communication Services', famous: true },
  { symbol: 'TROW', name: 'T. Rowe Price', region: 'Financials', famous: false },
  { symbol: 'TTWO', name: 'Take-Two Interactive', region: 'Communication Services', famous: true },
  { symbol: 'TPR', name: 'Tapestry', region: 'Consumer Discretionary', famous: true },
  { symbol: 'TRGP', name: 'Targa Resources', region: 'Energy', famous: false },
  { symbol: 'TGT', name: 'Target', region: 'Consumer Staples', famous: true },
  { symbol: 'TEL', name: 'TE Connectivity', region: 'Information Technology', famous: false },
  { symbol: 'TDY', name: 'Teledyne', region: 'Information Technology', famous: false },
  { symbol: 'TER', name: 'Teradyne', region: 'Information Technology', famous: false },
  { symbol: 'TSLA', name: 'Tesla', region: 'Consumer Discretionary', famous: true },
  { symbol: 'TXN', name: 'Texas Instruments', region: 'Information Technology', famous: false },
  { symbol: 'TPL', name: 'Texas Pacific Land', region: 'Energy', famous: false },
  { symbol: 'TXT', name: 'Textron', region: 'Industrials', famous: false },
  { symbol: 'TMO', name: 'Thermo Fisher Scientific', region: 'Health Care', famous: false },
  { symbol: 'TJX', name: 'TJX Companies', region: 'Consumer Discretionary', famous: false },
  { symbol: 'TKO', name: 'TKO Group', region: 'Communication Services', famous: false },
  { symbol: 'TTD', name: 'Trade Desk (The)', region: 'Communication Services', famous: false },
  { symbol: 'TSCO', name: 'Tractor Supply', region: 'Consumer Discretionary', famous: false },
  { symbol: 'TT', name: 'Trane', region: 'Industrials', famous: false },
  { symbol: 'TDG', name: 'TransDigm', region: 'Industrials', famous: false },
  { symbol: 'TRV', name: 'Travelers Companies (The)', region: 'Financials', famous: false },
  { symbol: 'TRMB', name: 'Trimble', region: 'Information Technology', famous: false },
  { symbol: 'TFC', name: 'Truist Financial', region: 'Financials', famous: false },
  { symbol: 'TYL', name: 'Tyler', region: 'Information Technology', famous: false },
  { symbol: 'TSN', name: 'Tyson Foods', region: 'Consumer Staples', famous: false },
  { symbol: 'USB', name: 'U.S. Bancorp', region: 'Financials', famous: false },
  { symbol: 'UBER', name: 'Uber', region: 'Industrials', famous: true },
  { symbol: 'UDR', name: 'UDR', region: 'Real Estate', famous: false },
  { symbol: 'ULTA', name: 'Ulta Beauty', region: 'Consumer Discretionary', famous: false },
  { symbol: 'UNP', name: 'Union Pacific', region: 'Industrials', famous: false },
  { symbol: 'UAL', name: 'United Airlines', region: 'Industrials', famous: true },
  { symbol: 'UPS', name: 'United Parcel Service', region: 'Industrials', famous: false },
  { symbol: 'URI', name: 'United Rentals', region: 'Industrials', famous: false },
  { symbol: 'UNH', name: 'UnitedHealth', region: 'Health Care', famous: true },
  { symbol: 'UHS', name: 'Universal Health Services', region: 'Health Care', famous: false },
  { symbol: 'VLO', name: 'Valero Energy', region: 'Energy', famous: false },
  { symbol: 'VEEV', name: 'Veeva Systems', region: 'Health Care', famous: false },
  { symbol: 'VTR', name: 'Ventas', region: 'Real Estate', famous: false },
  { symbol: 'VLTO', name: 'Veralto', region: 'Industrials', famous: false },
  { symbol: 'VRSN', name: 'Verisign', region: 'Information Technology', famous: false },
  { symbol: 'VRSK', name: 'Verisk Analytics', region: 'Industrials', famous: false },
  { symbol: 'VZ', name: 'Verizon', region: 'Communication Services', famous: true },
  { symbol: 'VRTX', name: 'Vertex Pharmaceuticals', region: 'Health Care', famous: false },
  { symbol: 'VRT', name: 'Vertiv', region: 'Industrials', famous: false },
  { symbol: 'VTRS', name: 'Viatris', region: 'Health Care', famous: false },
  { symbol: 'VICI', name: 'Vici Properties', region: 'Real Estate', famous: false },
  { symbol: 'V', name: 'Visa', region: 'Financials', famous: true },
  { symbol: 'VST', name: 'Vistra', region: 'Utilities', famous: false },
  { symbol: 'VMC', name: 'Vulcan Materials', region: 'Materials', famous: false },
  { symbol: 'WRB', name: 'W. R. Berkley', region: 'Financials', famous: false },
  { symbol: 'GWW', name: 'W. W. Grainger', region: 'Industrials', famous: false },
  { symbol: 'WAB', name: 'Wabtec', region: 'Industrials', famous: false },
  { symbol: 'WMT', name: 'Walmart', region: 'Consumer Staples', famous: true },
  { symbol: 'DIS', name: 'Walt Disney Company (The)', region: 'Communication Services', famous: true },
  { symbol: 'WBD', name: 'Warner Bros. Discovery', region: 'Communication Services', famous: true },
  { symbol: 'WM', name: 'Waste Management', region: 'Industrials', famous: false },
  { symbol: 'WAT', name: 'Waters', region: 'Health Care', famous: false },
  { symbol: 'WEC', name: 'WEC Energy', region: 'Utilities', famous: false },
  { symbol: 'WFC', name: 'Wells Fargo', region: 'Financials', famous: true },
  { symbol: 'WELL', name: 'Welltower', region: 'Real Estate', famous: false },
  { symbol: 'WST', name: 'West Pharmaceutical Servi', region: 'Health Care', famous: false },
  { symbol: 'WDC', name: 'Western Digital', region: 'Information Technology', famous: false },
  { symbol: 'WY', name: 'Weyerhaeuser', region: 'Real Estate', famous: false },
  { symbol: 'WSM', name: 'Williams-Sonoma', region: 'Consumer Discretionary', famous: false },
  { symbol: 'WMB', name: 'Williams Companies', region: 'Energy', famous: false },
  { symbol: 'WTW', name: 'Willis Towers Watson', region: 'Financials', famous: false },
  { symbol: 'WDAY', name: 'Workday', region: 'Information Technology', famous: false },
  { symbol: 'WYNN', name: 'Wynn Resorts', region: 'Consumer Discretionary', famous: true },
  { symbol: 'XEL', name: 'Xcel Energy', region: 'Utilities', famous: false },
  { symbol: 'XYL', name: 'Xylem', region: 'Industrials', famous: false },
  { symbol: 'YUM', name: 'Yum! Brands', region: 'Consumer Discretionary', famous: true },
  { symbol: 'ZBRA', name: 'Zebra', region: 'Information Technology', famous: false },
  { symbol: 'ZBH', name: 'Zimmer Biomet', region: 'Health Care', famous: false },
  { symbol: 'ZTS', name: 'Zoetis', region: 'Health Care', famous: false },
  { symbol: 'TM', name: 'Toyota', region: 'Asia', famous: true },
  { symbol: 'SONY', name: 'Sony', region: 'Asia', famous: true },
  { symbol: 'HMC', name: 'Honda', region: 'Asia', famous: true },
  { symbol: 'MUFG', name: 'Mitsubishi UFJ', region: 'Asia', famous: false },
  { symbol: 'SMFG', name: 'Sumitomo Mitsui', region: 'Asia', famous: false },
  { symbol: 'BABA', name: 'Alibaba', region: 'Asia', famous: true },
  { symbol: 'JD', name: 'JD.com', region: 'Asia', famous: true },
  { symbol: 'PDD', name: 'PDD (Temu)', region: 'Asia', famous: true },
  { symbol: 'BIDU', name: 'Baidu', region: 'Asia', famous: true },
  { symbol: 'NIO', name: 'NIO', region: 'Asia', famous: true },
  { symbol: 'LI', name: 'Li Auto', region: 'Asia', famous: false },
  { symbol: 'XPEV', name: 'XPeng', region: 'Asia', famous: false },
  { symbol: 'NTES', name: 'NetEase', region: 'Asia', famous: false },
  { symbol: 'TCOM', name: 'Trip.com', region: 'Asia', famous: false },
  { symbol: 'BILI', name: 'Bilibili', region: 'Asia', famous: false },
  { symbol: 'TSM', name: 'TSMC', region: 'Asia', famous: true },
  { symbol: 'UMC', name: 'United Micro', region: 'Asia', famous: false },
  { symbol: 'CPNG', name: 'Coupang', region: 'Asia', famous: true },
  { symbol: 'SE', name: 'Sea Limited', region: 'Asia', famous: true },
  { symbol: 'GRAB', name: 'Grab', region: 'Asia', famous: false },
  { symbol: 'INFY', name: 'Infosys', region: 'Asia', famous: false },
  { symbol: 'HDB', name: 'HDFC Bank', region: 'Asia', famous: false },
  { symbol: 'IBN', name: 'ICICI Bank', region: 'Asia', famous: false },
  { symbol: 'WIT', name: 'Wipro', region: 'Asia', famous: false },
  { symbol: 'SHEL', name: 'Shell', region: 'Europe', famous: true },
  { symbol: 'BP', name: 'BP', region: 'Europe', famous: true },
  { symbol: 'HSBC', name: 'HSBC', region: 'Europe', famous: true },
  { symbol: 'BCS', name: 'Barclays', region: 'Europe', famous: false },
  { symbol: 'LYG', name: 'Lloyds', region: 'Europe', famous: false },
  { symbol: 'AZN', name: 'AstraZeneca', region: 'Europe', famous: true },
  { symbol: 'GSK', name: 'GSK', region: 'Europe', famous: true },
  { symbol: 'UL', name: 'Unilever', region: 'Europe', famous: true },
  { symbol: 'DEO', name: 'Diageo', region: 'Europe', famous: true },
  { symbol: 'BTI', name: 'British American Tob', region: 'Europe', famous: false },
  { symbol: 'RIO', name: 'Rio Tinto', region: 'Europe', famous: false },
  { symbol: 'ARM', name: 'Arm', region: 'Europe', famous: true },
  { symbol: 'ASML', name: 'ASML', region: 'Europe', famous: true },
  { symbol: 'SAP', name: 'SAP', region: 'Europe', famous: true },
  { symbol: 'NVO', name: 'Novo Nordisk', region: 'Europe', famous: true },
  { symbol: 'SAN', name: 'Santander', region: 'Europe', famous: false },
  { symbol: 'BBVA', name: 'BBVA', region: 'Europe', famous: false },
  { symbol: 'TTE', name: 'TotalEnergies', region: 'Europe', famous: true },
  { symbol: 'SNY', name: 'Sanofi', region: 'Europe', famous: false },
  { symbol: 'DB', name: 'Deutsche Bank', region: 'Europe', famous: false },
  { symbol: 'ING', name: 'ING', region: 'Europe', famous: false },
  { symbol: 'STLA', name: 'Stellantis', region: 'Europe', famous: false },
  { symbol: 'RACE', name: 'Ferrari', region: 'Europe', famous: true },
  { symbol: 'SPOT', name: 'Spotify', region: 'Europe', famous: true },
  { symbol: 'ERIC', name: 'Ericsson', region: 'Europe', famous: true },
  { symbol: 'NOK', name: 'Nokia', region: 'Europe', famous: true },
  { symbol: 'SHOP', name: 'Shopify', region: 'Americas', famous: true },
  { symbol: 'MELI', name: 'MercadoLibre', region: 'Americas', famous: true },
  { symbol: 'NU', name: 'Nubank', region: 'Americas', famous: true },
  { symbol: 'VALE', name: 'Vale', region: 'Americas', famous: false },
  { symbol: 'PBR', name: 'Petrobras', region: 'Americas', famous: false },
  { symbol: 'TD', name: 'TD Bank', region: 'Americas', famous: false },
  { symbol: 'RY', name: 'Royal Bank of Canada', region: 'Americas', famous: false },
  { symbol: 'CNQ', name: 'Canadian Natural Res', region: 'Americas', famous: false },
];


// ===================== TIME WINDOWS (ET) =====================
function getETParts() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    weekday: parts.weekday,
  };
}
 
function decideSession() {
  if (process.env.RUN_NOW) return process.env.RUN_NOW;
 
  const { hour, minute, weekday } = getETParts();
  if (weekday === 'Sat' || weekday === 'Sun') return null;
 
  // Premarket scan: 8:30–8:44 AM ET (one tick)
  if (hour === 8 && minute >= 30 && minute <= 44) return 'premarket';
 
  // Intraday scans: 10:30 AM, 12:30 PM, 2:30 PM ET
  if ((hour === 10 || hour === 12 || hour === 14) && minute >= 30 && minute <= 44) return 'intraday';
 
  // Post-market scan: 5:00–5:14 PM ET (one tick)
  if (hour === 17 && minute >= 0 && minute <= 14) return 'postmarket';
 
  return null;
}
 
// ===================== YAHOO QUOTES =====================
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
 
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
 
async function getQuotes(symbols) {
  try {
    const one = await yahooFinance.quote('AAPL', {}, { validateResult: false });
    console.log('Single AAPL test:', one ? JSON.stringify(one).slice(0, 200) : 'returned undefined');
  } catch (e) {
    console.error('Single AAPL test failed:', String(e).slice(0, 300));
  }

  const results = [];
  const batches = chunk(symbols, QUOTE_CHUNK_SIZE);
  for (let i = 0; i < batches.length; i++) {
    try {
      const data = await yahooFinance.quote(batches[i], {}, { validateResult: false });
      console.log(`Batch ${i + 1}: type=${Array.isArray(data) ? 'array' : typeof data}, length=${Array.isArray(data) ? data.length : 'n/a'}`);
      if (Array.isArray(data)) results.push(...data);
      else if (data) console.log('Raw sample:', JSON.stringify(data).slice(0, 300));
    } catch (err) {
      console.error(`Yahoo batch ${i + 1} error:`, String(err).slice(0, 300));
    }
    if (i < batches.length - 1) await sleep(CHUNK_DELAY_MS);
  }
  return results;
}
 
// ===================== DATABASE =====================
async function initDb(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS mover_alerts (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      pct NUMERIC,
      price NUMERIC,
      tweet_id TEXT,
      posted_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS high_watermarks (
      symbol TEXT PRIMARY KEY,
      high NUMERIC NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
 
async function isOnCooldown(db, symbol, alertType) {
  const hours = COOLDOWN_HOURS[alertType] || 20;
  const { rows } = await db.query(
    `SELECT 1 FROM mover_alerts
     WHERE symbol = $1 AND alert_type = $2
       AND posted_at > NOW() - ($3 || ' hours')::interval
     LIMIT 1`,
    [symbol, alertType, String(hours)]
  );
  return rows.length > 0;
}
 
async function loadWatermarks(db) {
  const { rows } = await db.query('SELECT symbol, high FROM high_watermarks');
  const map = new Map();
  for (const r of rows) map.set(r.symbol, parseFloat(r.high));
  return map;
}
 
async function upsertWatermark(db, symbol, high) {
  await db.query(
    `INSERT INTO high_watermarks (symbol, high, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (symbol) DO UPDATE
       SET high = EXCLUDED.high, updated_at = NOW()
       WHERE high_watermarks.high < EXCLUDED.high`,
    [symbol, high]
  );
}
 
// ===================== TWEET BUILDERS =====================
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
 
function fmtPrice(p) {
  return p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 2 }) : p.toFixed(2);
}
 
function fmtPct(p) {
  const sign = p > 0 ? '+' : '';
  return `${sign}${p.toFixed(1)}%`;
}
 
const UP_LINES = [
  'Something\u2019s cooking \uD83D\uDC40',
  'Bulls are awake \uD83D\uDCC8',
  'Send it \uD83D\uDE80',
  'Green candles printing \uD83D\uDFE2',
  'Degens, eyes on this one \uD83D\uDC40',
];
 
const DOWN_LINES = [
  'Someone\u2019s getting rekt \uD83D\uDC80',
  'Knife catching, anyone? \uD83D\uDD2A',
  'Bears feasting today \uD83D\uDC3B',
  'Red wedding vibes \uD83D\uDD3B',
  'That\u2019s gonna leave a mark \uD83D\uDE2C',
];
 
function buildTweet(alert) {
  const { type, symbol, name, pct, price, high } = alert;
 
  switch (type) {
    case 'premarket_up':
      return `\uD83D\uDEA8 PREMARKET MOVER\n\n$${symbol} ${fmtPct(pct)} before the bell\n\n${name}\nNow ~$${fmtPrice(price)}\n\n${pick(UP_LINES)}\n\n#premarket #stocks #trading`;
    case 'premarket_down':
      return `\uD83D\uDEA8 PREMARKET MOVER\n\n$${symbol} ${fmtPct(pct)} before the bell\n\n${name}\nNow ~$${fmtPrice(price)}\n\n${pick(DOWN_LINES)}\n\n#premarket #stocks #trading`;
    case 'move_up':
      return `\uD83D\uDFE2 $${symbol} ripping ${fmtPct(pct)} today\n\n${name}\nNow trading at $${fmtPrice(price)}\n\n${pick(UP_LINES)}\n\n#stocks #trading`;
    case 'move_down':
      return `\uD83D\uDD34 $${symbol} dumping ${fmtPct(pct)} today\n\n${name}\nNow trading at $${fmtPrice(price)}\n\n${pick(DOWN_LINES)}\n\n#stocks #trading`;
    case 'postmarket_up':
      return `\uD83C\uDF19 AFTER-HOURS MOVER\n\n$${symbol} ${fmtPct(pct)} post-market\n\n${name}\nNow ~$${fmtPrice(price)}\n\n${pick(UP_LINES)}\n\n#afterhours #stocks`;
    case 'postmarket_down':
      return `\uD83C\uDF19 AFTER-HOURS MOVER\n\n$${symbol} ${fmtPct(pct)} post-market\n\n${name}\nNow ~$${fmtPrice(price)}\n\n${pick(DOWN_LINES)}\n\n#afterhours #stocks`;
    case 'new_high':
      return `\uD83C\uDFD4 NEW 52-WEEK HIGH\n\n$${symbol} just printed $${fmtPrice(price)}\n\n${name} has never been higher in the last year\n\nAll-time-high energy \uD83D\uDE80\n\n#stocks #52weekhigh #ATH`;
    case 'drawdown':
      return `\uD83D\uDCC9 DOWN BAD ALERT\n\n$${symbol} is now ${DRAWDOWN_THRESHOLD}%+ below its 52-week high\n\n${name}\nHigh: $${fmtPrice(high)} \u2192 now $${fmtPrice(price)}\n\nDip or falling knife? \uD83D\uDD2A\n\n#stocks #buythedip`;
    default:
      return null;
  }
}
 
// ===================== SCAN LOGIC =====================
function displayName(q) {
  return q.displayName || q.shortName || q.longName || q.symbol;
}
 
function scanExtended(quotes, session) {
  const pctField = session === 'premarket' ? 'preMarketChangePercent' : 'postMarketChangePercent';
  const priceField = session === 'premarket' ? 'preMarketPrice' : 'postMarketPrice';
  const candidates = [];
 
  for (const q of quotes) {
    const pct = q[pctField];
    const price = q[priceField];
    if (typeof pct !== 'number' || typeof price !== 'number') continue;
    if (price < MIN_PRICE) continue;
    if (Math.abs(pct) < EXTENDED_THRESHOLD) continue;
 
    const direction = pct > 0 ? 'up' : 'down';
    candidates.push({
      type: `${session}_${direction}`,
      symbol: q.symbol,
      name: displayName(q),
      pct,
      price,
    });
  }
  return candidates;
}
 
function scanIntraday(quotes) {
  const candidates = [];
  for (const q of quotes) {
    const price = q.regularMarketPrice;
    const pct = q.regularMarketChangePercent;
    if (typeof price !== 'number' || price < MIN_PRICE) continue;
    if (typeof pct !== 'number' || Math.abs(pct) < MOVE_THRESHOLD) continue;
    const direction = pct > 0 ? 'up' : 'down';
    candidates.push({
      type: `move_${direction}`,
      symbol: q.symbol,
      name: displayName(q),
      pct,
      price,
    });
  }
  return candidates;
}
 
function scanHighsAndDrawdowns(quotes, watermarks) {
  const candidates = [];
  for (const q of quotes) {
    const price = q.regularMarketPrice;
    const yearHigh = q.fiftyTwoWeekHigh;
    if (typeof price !== 'number' || price < MIN_PRICE) continue;
    if (typeof yearHigh !== 'number' || yearHigh <= 0) continue;
 
    const stored = watermarks.get(q.symbol) || 0;
    const watermark = Math.max(stored, yearHigh);
 
    // New 52-week high: at/above yearHigh AND above anything we've seen before
    if (price >= yearHigh && price > stored) {
      candidates.push({
        type: 'new_high',
        symbol: q.symbol,
        name: displayName(q),
        pct: q.regularMarketChangePercent || 0,
        price,
        high: price,
      });
    }
 
    // Drawdown: at/below threshold vs watermark
    if (price <= watermark * (1 - DRAWDOWN_THRESHOLD / 100)) {
      const ddPct = ((price - watermark) / watermark) * 100;
      candidates.push({
        type: 'drawdown',
        symbol: q.symbol,
        name: displayName(q),
        pct: ddPct,
        price,
        high: watermark,
      });
    }
  }
  return candidates;
}
 
const TYPE_PRIORITY = {
  drawdown: 0,
  new_high: 1,
  premarket_up: 2,
  premarket_down: 2,
  postmarket_up: 2,
  postmarket_down: 2,
  move_up: 2,
  move_down: 2,
};
 
// ===================== MAIN =====================
async function main() {
  for (const v of ['DATABASE_URL', 'X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET']) {
    if (!process.env[v]) throw new Error(`Missing required env var: ${v}`);
  }
 
  const session = decideSession();
  if (!session) {
    console.log('Outside scan windows (or weekend). Exiting.');
    return;
  }
  console.log(`Running ${session} scan for ${TICKERS.length} tickers via Yahoo Finance...`);
 
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await initDb(db);
 
  const twitter = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });
 
  try {
    const quotes = await getQuotes(TICKERS);
    console.log(`Got ${quotes.length} quotes.`);
    if (quotes.length === 0) {
      console.error('No quotes returned — Yahoo may be blocking or all batches failed.');
      return;
    }
 
    let candidates = [];
 
    if (session === 'premarket' || session === 'postmarket') {
      candidates = scanExtended(quotes, session);
    } else {
      candidates = scanIntraday(quotes);
    }
 
    // Highs/drawdowns use regular-session prices — skip during premarket
    const watermarks = await loadWatermarks(db);
    if (session !== 'premarket') {
      candidates.push(...scanHighsAndDrawdowns(quotes, watermarks));
    }
 
    console.log(`${candidates.length} raw candidates.`);
 
    // Sort: drawdowns first, then new highs, then biggest movers
    candidates.sort((a, b) => {
      const pa = TYPE_PRIORITY[a.type] ?? 9;
      const pb = TYPE_PRIORITY[b.type] ?? 9;
      if (pa !== pb) return pa - pb;
      return Math.abs(b.pct) - Math.abs(a.pct);
    });
 
    let posted = 0;
    for (const alert of candidates) {
      if (posted >= MAX_ALERTS_PER_SCAN) break;
 
      if (await isOnCooldown(db, alert.symbol, alert.type)) {
        continue;
      }
 
      const text = buildTweet(alert);
      if (!text || text.length > 280) {
        console.log(`Skipping ${alert.symbol} ${alert.type}: bad tweet length.`);
        continue;
      }
 
      // Save to DB BEFORE posting (prevents duplicate spam if post partially fails)
      const { rows } = await db.query(
        `INSERT INTO mover_alerts (symbol, alert_type, pct, price)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [alert.symbol, alert.type, alert.pct, alert.price]
      );
      const alertId = rows[0].id;
 
      try {
        const tweet = await twitter.v2.tweet(text);
        await db.query('UPDATE mover_alerts SET tweet_id = $1 WHERE id = $2', [
          tweet.data.id,
          alertId,
        ]);
        console.log(`Posted ${alert.type} for $${alert.symbol} (${fmtPct(alert.pct)}): ${tweet.data.id}`);
        posted++;
      } catch (err) {
        console.error(`Tweet failed for ${alert.symbol}:`, err.message);
      }
    }
 
    console.log(`Posted ${posted} alert(s).`);
 
    // Ratchet watermarks upward (regular-session data only)
    if (session !== 'premarket') {
      let updated = 0;
      for (const q of quotes) {
        const price = q.regularMarketPrice;
        const yearHigh = q.fiftyTwoWeekHigh;
        const newHigh = Math.max(yearHigh || 0, price || 0);
        if (newHigh <= 0) continue;
        const stored = watermarks.get(q.symbol) || 0;
        if (newHigh > stored) {
          await upsertWatermark(db, q.symbol, newHigh);
          updated++;
        }
      }
      console.log(`Watermarks updated for ${updated} symbols.`);
    }
  } finally {
    await db.end();
  }
}
 
main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
 
