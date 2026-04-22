const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');

async function run() {
  try {
    const db = new Database('server/data/travel.db');
    const user = db.prepare('SELECT id, email FROM users LIMIT 1').get();
    if (!user) { console.log('No user found'); return; }
    const trip = db.prepare('SELECT id FROM trips WHERE user_id = ? LIMIT 1').get(user.id);
    if (!trip) { console.log('No trip found for user ' + user.id); return; }

    console.log('User ID:', user.id);
    console.log('Trip ID:', trip.id);

    // Try to find the secret
    let secret = process.env.JWT_SECRET;
    if (!secret) {
      const fs = require('fs');
      const path = require('path');
      const secretFile = path.join('server', 'data', '.jwt_secret');
      if (fs.existsSync(secretFile)) {
        secret = fs.readFileSync(secretFile, 'utf8').trim();
      } else {
        console.log('JWT Secret file not found. Localhost check first.');
        try {
          const res = await fetch('http://localhost:3001/api/tags');
          console.log('Port 3001 is reachable.');
        } catch (e) {
          console.log('localhost:3001 is not running');
          return;
        }
        console.log('Cannot proceed without JWT secret.');
        return;
      }
    }

    const token = jwt.sign({ id: user.id }, secret);
    const endpoints = [
      '/api/trips/' + trip.id,
      '/api/trips/' + trip.id + '/days',
      '/api/trips/' + trip.id + '/places',
      '/api/trips/' + trip.id + '/packing',
      '/api/tags',
      '/api/categories'
    ];

    for (const endpoint of endpoints) {
      const url = 'http://localhost:3001' + endpoint;
      try {
        const res = await fetch(url, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!res.ok) {
          const body = await res.text();
          console.log('FAIL: ' + endpoint + ' Status: ' + res.status);
          console.log('Body: ' + body.substring(0, 200));
          return;
        } else {
          console.log('SUCCESS: ' + endpoint);
        }
      } catch (e) {
         console.log('ERROR: ' + endpoint + ' ' + e.message);
         return;
      }
    }
    console.log('All endpoints succeeded.');
  } catch (err) {
    console.error(err);
  }
}

run();
