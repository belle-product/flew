require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const db = new Database('flew.db');

app.use(express.json());
app.use(express.static('public'));

db.exec(`
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_number TEXT NOT NULL,
    airline TEXT,
    rating INTEGER NOT NULL,
    comment TEXT,
    tags TEXT,
    username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_number TEXT NOT NULL,
    airline TEXT,
    username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS flights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_number TEXT UNIQUE NOT NULL,
    airline TEXT,
    departure_airport TEXT,
    departure_city TEXT,
    arrival_airport TEXT,
    arrival_city TEXT,
    departure_time TEXT,
    arrival_time TEXT,
    status TEXT,
    aircraft TEXT,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const airlines = {
  'AA': 'American Airlines', 'DL': 'Delta Air Lines', 'UA': 'United Airlines',
  'WN': 'Southwest Airlines', 'B6': 'JetBlue', 'AS': 'Alaska Airlines',
  'NK': 'Spirit Airlines', 'F9': 'Frontier Airlines', 'HA': 'Hawaiian Airlines',
  'G4': 'Allegiant Air', 'BA': 'British Airways', 'LH': 'Lufthansa',
  'AF': 'Air France', 'EK': 'Emirates', 'QR': 'Qatar Airways',
  'SQ': 'Singapore Airlines', 'CX': 'Cathay Pacific', 'JL': 'Japan Airlines',
  'NH': 'ANA', 'KE': 'Korean Air', 'OZ': 'Asiana Airlines',
  'CA': 'Air China', 'MU': 'China Eastern', 'CZ': 'China Southern',
  'TK': 'Turkish Airlines', 'ET': 'Ethiopian Airlines', 'QF': 'Qantas',
  'NZ': 'Air New Zealand', 'AC': 'Air Canada', 'AM': 'Aeromexico',
  'LA': 'LATAM', 'AV': 'Avianca', 'IB': 'Iberia', 'VY': 'Vueling',
  'FR': 'Ryanair', 'U2': 'easyJet', 'W6': 'Wizz Air',
  'AZ': 'ITA Airways', 'LX': 'Swiss', 'OS': 'Austrian', 'KL': 'KLM',
  'SK': 'SAS', 'AY': 'Finnair', 'EI': 'Aer Lingus', 'TP': 'TAP Air Portugal',
  'MS': 'EgyptAir', 'EY': 'Etihad', 'FZ': 'flydubai', 'WY': 'Oman Air',
  'AI': 'Air India', 'SG': 'SpiceJet', '6E': 'IndiGo',
  'TG': 'Thai Airways', 'MH': 'Malaysia Airlines', 'GA': 'Garuda Indonesia',
  'PR': 'Philippine Airlines', 'VN': 'Vietnam Airlines', 'BR': 'EVA Air',
  'CI': 'China Airlines'
};

function getAirline(flightNumber) {
  const code = flightNumber.replace(/[^A-Z]/g, '').substring(0, 2);
  return airlines[code] || 'Unknown Airline';
}

// Fetch flight from AviationStack and cache in DB
async function fetchFlightFromAPI(flightNumber) {
  const apiKey = process.env.AVIATIONSTACK_KEY;
  if (!apiKey) return null;

  try {
    const url = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}&flight_iata=${flightNumber}&limit=1`;
    const response = await fetch(url);
    const data = await response.json();

    if (!data.data || data.data.length === 0) return null;

    const f = data.data[0];
    const flightData = {
      flight_number: flightNumber,
      airline: f.airline?.name || getAirline(flightNumber),
      departure_airport: f.departure?.iata || null,
      departure_city: f.departure?.airport || null,
      arrival_airport: f.arrival?.iata || null,
      arrival_city: f.arrival?.airport || null,
      departure_time: f.departure?.scheduled || null,
      arrival_time: f.arrival?.scheduled || null,
      status: f.flight_status || null,
      aircraft: f.aircraft?.iata || null
    };

    // Cache in DB (insert or replace)
    db.prepare(`
      INSERT INTO flights (flight_number, airline, departure_airport, departure_city, arrival_airport, arrival_city, departure_time, arrival_time, status, aircraft, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(flight_number) DO UPDATE SET
        airline=excluded.airline,
        departure_airport=excluded.departure_airport,
        departure_city=excluded.departure_city,
        arrival_airport=excluded.arrival_airport,
        arrival_city=excluded.arrival_city,
        departure_time=excluded.departure_time,
        arrival_time=excluded.arrival_time,
        status=excluded.status,
        aircraft=excluded.aircraft,
        fetched_at=CURRENT_TIMESTAMP
    `).run(
      flightData.flight_number, flightData.airline,
      flightData.departure_airport, flightData.departure_city,
      flightData.arrival_airport, flightData.arrival_city,
      flightData.departure_time, flightData.arrival_time,
      flightData.status, flightData.aircraft
    );

    return flightData;
  } catch (err) {
    console.error('AviationStack error:', err.message);
    return null;
  }
}

// GET /api/flight/:flightNumber — check DB first, then API
app.get('/api/flight/:flightNumber', async (req, res) => {
  const flightNumber = req.params.flightNumber.toUpperCase().replace(/\s/g, '');

  // Check DB cache first (only re-fetch if older than 1 hour)
  const cached = db.prepare(`
    SELECT * FROM flights WHERE flight_number = ?
    AND fetched_at > datetime('now', '-1 hour')
  `).get(flightNumber);

  if (cached) {
    const reviews = db.prepare('SELECT * FROM reviews WHERE UPPER(flight_number) = ? ORDER BY created_at DESC').all(flightNumber);
    return res.json({ ...cached, reviews, source: 'cache' });
  }

  // Not cached — hit AviationStack
  const flightData = await fetchFlightFromAPI(flightNumber);

  if (!flightData) {
    // Fall back to just airline lookup from our map
    const airline = getAirline(flightNumber);
    const reviews = db.prepare('SELECT * FROM reviews WHERE UPPER(flight_number) = ? ORDER BY created_at DESC').all(flightNumber);
    return res.json({ flight_number: flightNumber, airline, reviews, source: 'local' });
  }

  const reviews = db.prepare('SELECT * FROM reviews WHERE UPPER(flight_number) = ? ORDER BY created_at DESC').all(flightNumber);
  res.json({ ...flightData, reviews, source: 'api' });
});

app.get('/api/stats', (req, res) => {
  const reviews = db.prepare('SELECT COUNT(*) as count FROM reviews').get().count;
  const flights = db.prepare('SELECT COUNT(DISTINCT flight_number) as count FROM reviews').get().count;
  const avg = db.prepare('SELECT AVG(rating) as avg FROM reviews').get().avg;
  res.json({ reviews, flights, avg });
});

app.get('/api/reviews/:flight', (req, res) => {
  const flight = req.params.flight.toUpperCase().replace(/\s/g, '');
  const reviews = db.prepare('SELECT * FROM reviews WHERE UPPER(flight_number) = ? ORDER BY created_at DESC').all(flight);
  const airline = getAirline(flight);
  res.json({ flight, airline, reviews });
});

app.post('/api/reviews', (req, res) => {
  const { flight_number, rating, comment, tags, username } = req.body;
  if (!flight_number || !rating) return res.status(400).json({ error: 'Missing required fields' });
  const flight = flight_number.toUpperCase().replace(/\s/g, '');
  const airline = getAirline(flight);
  const result = db.prepare('INSERT INTO reviews (flight_number, airline, rating, comment, tags, username) VALUES (?, ?, ?, ?, ?, ?)')
    .run(flight, airline, rating, comment, JSON.stringify(tags || []), username || 'Anonymous');
  res.json({ id: result.lastInsertRowid, flight_number: flight, airline, rating });
});

app.post('/api/checkins', (req, res) => {
  const { flight_number, username } = req.body;
  if (!flight_number) return res.status(400).json({ error: 'Missing flight number' });
  const flight = flight_number.toUpperCase().replace(/\s/g, '');
  const airline = getAirline(flight);
  const result = db.prepare('INSERT INTO checkins (flight_number, airline, username) VALUES (?, ?, ?)')
    .run(flight, airline, username || 'Anonymous');
  res.json({ id: result.lastInsertRowid, flight_number: flight, airline });
});

app.get('/api/feed', (req, res) => {
  const reviews = db.prepare('SELECT *, "review" as type FROM reviews ORDER BY created_at DESC LIMIT 20').all();
  const checkins = db.prepare('SELECT *, "checkin" as type FROM checkins ORDER BY created_at DESC LIMIT 20').all();
  const feed = [...reviews, ...checkins].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 30);
  res.json(feed);
});

app.get('/api/top', (req, res) => {
  const { from, to, airline, region, q } = req.query;
  let sql = 'SELECT flight_number, airline, AVG(rating) as avg_rating, COUNT(*) as review_count FROM reviews WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND (UPPER(flight_number) LIKE ? OR UPPER(flight_number) LIKE ?)'; params.push('%' + q + '%', '%' + q + '%'); }
  if (airline) { sql += ' AND airline = ?'; params.push(airline); }
  sql += ' GROUP BY flight_number ORDER BY avg_rating DESC, review_count DESC LIMIT 20';
  const results = db.prepare(sql).all(...params);
  res.json(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`flew. running on http://localhost:${PORT}`));
