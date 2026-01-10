const { MongoClient } = require('mongodb');
require('dotenv').config();

const uri = process.env.MONGODB_URI;

// Check if URI exists before trying to connect
if (!uri) {
  console.error("❌ ERROR: MONGODB_URI is not defined in your .env file.");
}

let db;
let client;

async function connectToDatabase() {
  if (db) return db;
  
  try {
    // Initializing the client here ensures process.env is ready
    client = new MongoClient(uri); 
    await client.connect();
    db = client.db(); 
    console.log('✅ Connected to MongoDB');
    return db;
  } catch (error) {
    console.error('❌ Could not connect to MongoDB', error);
    process.exit(1);
  }
}

function getDb() {
    if (!db) {
        throw new Error('Database not initialized. Call connectToDatabase first.');
    }
    return db;
}

module.exports = { connectToDatabase, getDb };