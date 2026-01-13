require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Razorpay = require('razorpay');
const cors = require('cors');
const { connectToDatabase, getDb } = require('./database');
const { requireAdminLogin } = require('./auth');
const { sendTicketEmail } = require('./email');

const app = express();
const PORT = process.env.PORT || 5000;

new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// 1. FIXED CORS: Use an array to allow both local development and production URLs
const allowedOrigins = [
  'http://localhost:8080',
  'https://sambhavofficial.in',
  'https://www.sambhavofficial.in',
  'https://sambhav-frontend.onrender.com'
];

app.use(cors({ 
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('CORS block: This origin is not allowed'), false);
    }
    return callback(null, true);
  }, 
  credentials: true 
}));

app.use(express.json());

// 2. FIXED SESSION: Required for Render's HTTPS and Proxy setup
app.set('trust proxy', 1); // Crucial for session cookies to work on Render

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true, // Required because Render uses a load balancer/proxy
  cookie: { 
    secure: true,      // Must be true for HTTPS (Render/Vercel)
    httpOnly: true, 
    sameSite: 'none',  // Required for cross-site cookies between different domains
    maxAge: 1000 * 60 * 60 
  }
}));

/* ================= AUTH ROUTES ================= */
app.get("/api/auth/me", (req, res) => {
  if (req.session && req.session.user) return res.json({ authenticated: true, user: req.session.user });
  res.status(401).json({ authenticated: false });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.user = { id: 'admin', role: 'admin' };
    return res.json({ success: true, user: req.session.user });
  }
  res.status(401).json({ success: false, message: "Invalid credentials" });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

/* ================= EVENT ROUTES ================= */
app.get("/api/events", async (req, res) => {
  try {
    const db = getDb();
    const events = await db.collection('events').find({}).toArray();
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.post('/api/events', requireAdminLogin, async (req, res) => {
  try {
    const db = getDb();
    const event = { ...req.body, createdAt: new Date(), status: 'upcoming' };
    await db.collection('events').insertOne(event);
    res.json({ success: true, event });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.put('/api/events/:id', requireAdminLogin, async (req, res) => {
  try {
    const db = getDb();
    const { _id, ...updateData } = req.body; 
    const result = await db.collection('events').updateOne(
      { id: req.params.id },
      { $set: updateData }
    );
    res.json({ success: result.matchedCount > 0 });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.delete('/api/events/:id', requireAdminLogin, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('events').deleteOne({ id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

/* ================= PAYMENT & VERIFICATION ================= */
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_payment_id, eventTitle, name, email, formData } = req.body;
    const db = getDb();
    const timestamp = new Date();
    const ticketId = `TICKET-${Date.now()}`;

    if (!email) return res.status(400).json({ success: false, message: "Email required" });

    // 1. Save to tickets collection
    await db.collection('tickets').insertOne({
      _id: ticketId,
      event: eventTitle,
      primary_name: name,
      email: email,
      formData: formData || {},
      payment_id: razorpay_payment_id,
      status_day_1: 'pending',
      status_day_2: 'pending',
      createdAt: timestamp
    });

    // 2. Save to form_responses collection
    await db.collection('form_responses').insertOne({
      ticketId,
      eventTitle,
      respondentName: name,
      respondentEmail: email,
      dynamicAttributes: formData || {},
      submittedAt: timestamp
    });

    // 3. Respond immediately to prevent frontend "Connection Lost"
    res.json({ success: true, ticketId });

    // 4. Trigger Email in the background (No 'await')
    sendTicketEmail({ id: ticketId, event: eventTitle, primary_name: name, email })
      .catch(e => console.error("Background Email Error:", e));

  } catch (err) {
    console.error("Critical Payment Error:", err);
    if (!res.headersSent) res.status(500).json({ success: false });
  }
});

app.get('/api/registrations', requireAdminLogin, async (req, res) => {
  try {
    const db = getDb();
    const tickets = await db.collection('tickets').find({}).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, data: tickets });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

connectToDatabase().then(() => {
  app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
});


