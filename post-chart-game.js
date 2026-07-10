// post-chart-game.js
// Guess the Chart game for @DailyBrainDrop — v2
// - 561-ticker pool: full S&P 500 + international ADRs (all US-listed, free FMP tier)
// - 70% of games use famous household names; 30% harder mid-caps
// - Decoys drawn from the same sector/region so polls are a real challenge
// - Includes all fixes: ES module imports, DB-save-before-poll, poll error handling

import { TwitterApi } from 'twitter-api-v2';
import pg from 'pg';
const { Client } = pg;

// ============ CONFIG ============

const POST_SLOTS_UTC = [
  { hour: 3, minute: 30 },   // Asia prime time
  { hour: 12, minute: 30 },  // EU afternoon + US premarket overlap
];
const SLOT_WINDOW_MINUTES = 30;
const ANSWER_DELAY_HOURS = 2;
const CHART_DAYS = 180;
const FAMOUS_PICK_PROBABILITY = 0.7; // 70% famous names, 30% deep cuts

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

// Brand palette
const CHART_LINE_COLOR = '#FF6B6B';
const CHART_FILL_COLOR = 'rgba(255,107,107,0.12)';
const CHART_BG_COLOR = '#FFF9E6';

// ============ CLIENTS ============

const twitterClient = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

function newDbClient() {
  return new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ============ HELPERS ============

function inPostingWindow(now = new Date()) {
  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  return POST_SLOTS_UTC.some((slot) => {
    const slotMinutes = slot.hour * 60 + slot.minute;
    return Math.abs(minutesNow - slotMinutes) <= SLOT_WINDOW_MINUTES;
  });
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pick 3 decoys from the same sector/region group so the poll is challenging.
// When the answer is a famous name, prefer famous decoys (fair fight).
function pickDecoys(answer) {
  const peers = TICKERS.filter(
    (t) => t.symbol !== answer.symbol && t.region === answer.region
  );
  let pool = peers;
  if (answer.famous) {
    const famousPeers = peers.filter((t) => t.famous);
    if (famousPeers.length >= 3) pool = famousPeers;
  }
  const decoys = shuffle(pool).slice(0, 3);
  const filler = shuffle(
    TICKERS.filter((t) => t.symbol !== answer.symbol && !decoys.includes(t))
  );
  while (decoys.length < 3 && filler.length) decoys.push(filler.pop());
  return decoys;
}

async function fetchPriceHistory(symbol) {
  const to = new Date();
  const from = new Date(to.getTime() - CHART_DAYS * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const url =
    `https://financialmodelingprep.com/stable/historical-price-eod/light` +
    `?symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(to)}` +
    `&apikey=${process.env.FMP_API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP ${res.status} for ${symbol}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length < 30) {
    throw new Error(`Not enough price data for ${symbol}`);
  }
  // FMP returns newest-first; flip to oldest-first for charting
  return data.reverse().map((d) => d.price);
}

async function generateChartImage(prices) {
  const chartConfig = {
    type: 'line',
    data: {
      labels: prices.map(() => ''),
      datasets: [
        {
          data: prices,
          borderColor: CHART_LINE_COLOR,
          backgroundColor: CHART_FILL_COLOR,
          borderWidth: 3,
          pointRadius: 0,
          fill: true,
          tension: 0.15,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false }, title: { display: false } },
      scales: { x: { display: false }, y: { display: false } },
    },
  };

  const res = await fetch('https://quickchart.io/chart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chart: chartConfig,
      width: 800,
      height: 450,
      format: 'png',
      backgroundColor: CHART_BG_COLOR,
      version: '4',
    }),
  });
  if (!res.ok) throw new Error(`QuickChart error ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function percentChange(prices) {
  const first = prices[0];
  const last = prices[prices.length - 1];
  return (((last - first) / first) * 100).toFixed(1);
}

// ============ POST A NEW GAME ============

async function maybePostNewGame(db) {
  if (!inPostingWindow()) {
    console.log('Not in a chart-game posting window. Skipping post.');
    return;
  }

  const recent = await db.query(
    `SELECT id FROM chart_games WHERE posted_at > NOW() - INTERVAL '90 minutes'`
  );
  if (recent.rows.length > 0) {
    console.log('Chart game already posted this window. Skipping.');
    return;
  }

  // No repeats within 60 days (pool is big enough now)
  const recentSymbols = await db.query(
    `SELECT symbol FROM chart_games WHERE posted_at > NOW() - INTERVAL '60 days'`
  );
  const used = new Set(recentSymbols.rows.map((r) => r.symbol));
  const available = TICKERS.filter((t) => !used.has(t.symbol));
  const pool = available.length ? available : TICKERS;

  // Weighted pick: mostly famous names, sometimes a deep cut
  const famousPool = pool.filter((t) => t.famous);
  const usableFamous = famousPool.length ? famousPool : pool;
  const answer =
    Math.random() < FAMOUS_PICK_PROBABILITY
      ? pickRandom(usableFamous)
      : pickRandom(pool);

  console.log(`Posting chart game: ${answer.name} (${answer.symbol})`);

  const prices = await fetchPriceHistory(answer.symbol);
  const imageBuffer = await generateChartImage(prices);

  const mediaId = await twitterClient.v1.uploadMedia(imageBuffer, {
    mimeType: 'image/png',
  });

  const questionText =
    `🧠📈 GUESS THE CHART\n\n` +
    `This is a well-known company's stock over the last 6 months.\n\n` +
    `Can you name it? Vote in the poll below 👇\n` +
    `Answer drops in 2 hours!`;

  const question = await twitterClient.v2.tweet({
    text: questionText,
    media: { media_ids: [mediaId] },
  });
  const questionId = question.data.id;
  console.log(`Chart posted: ${questionId}`);

  // Save FIRST so the answer + dedup always work, even if the poll fails
  await db.query(
    `INSERT INTO chart_games (tweet_id, symbol, company, pct_change, posted_at, answered)
     VALUES ($1, $2, $3, $4, NOW(), FALSE)`,
    [questionId, answer.symbol, answer.name, percentChange(prices)]
  );
  console.log('Game saved to database.');

  // Poll reply with shuffled options (poll options max 25 chars)
  const options = shuffle([answer, ...pickDecoys(answer)]).map((t) =>
    t.name.slice(0, 25)
  );
  try {
    await twitterClient.v2.reply(
      `Which company is it? 🤔`,
      questionId,
      { poll: { options, duration_minutes: 120 } }
    );
    console.log('Poll reply posted.');
  } catch (err) {
    console.error('Poll reply failed:', JSON.stringify(err.data || err.message));
  }
}

// ============ ANSWER DUE GAMES ============

async function answerDueGames(db) {
  const due = await db.query(
    `SELECT id, tweet_id, symbol, company, pct_change
     FROM chart_games
     WHERE answered = FALSE
       AND posted_at < NOW() - INTERVAL '${ANSWER_DELAY_HOURS} hours'`
  );

  for (const game of due.rows) {
    const direction = parseFloat(game.pct_change) >= 0 ? '📈 up' : '📉 down';
    const answerText =
      `⏰ ANSWER TIME!\n\n` +
      `The mystery chart was... ${game.company} ($${game.symbol})! 🎉\n\n` +
      `It's ${direction} ${Math.abs(parseFloat(game.pct_change))}% over the last 6 months.\n\n` +
      `Did you get it? Drop a 🧠 if you nailed it!\n\n#GuessTheChart #stocks`;

    try {
      await twitterClient.v2.reply(answerText, game.tweet_id);
      await db.query(`UPDATE chart_games SET answered = TRUE WHERE id = $1`, [
        game.id,
      ]);
      console.log(`Answer posted for ${game.company} (game ${game.id}).`);
    } catch (err) {
      console.error(`Failed to answer game ${game.id}:`, err.message);
    }
  }

  if (due.rows.length === 0) console.log('No chart-game answers due.');
}

// ============ MAIN ============

async function main() {
  const db = newDbClient();
  await db.connect();

  await db.query(`
    CREATE TABLE IF NOT EXISTS chart_games (
      id SERIAL PRIMARY KEY,
      tweet_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      company TEXT NOT NULL,
      pct_change TEXT,
      posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      answered BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  try {
    await answerDueGames(db);
    await maybePostNewGame(db);
  } catch (err) {
    console.error('Chart game error:', err.message);
  } finally {
    await db.end();
  }
}

main();
