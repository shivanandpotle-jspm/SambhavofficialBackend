require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');

const { connectToDatabase, getDb } = require('./database');
const { requireAdminLogin } = require('./auth');
const { sendTicketEmail } = require('./email');

const app = express();
const PORT = process.env.PORT || 5000;

/* ================= RAZORPAY ================= */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* ================= CORS ================= */
const allowedOrigins = [
  'http://localhost:8080',
  'https://sambhavofficial.in',
  'https://www.sambhavofficial.in',
  'https://sambhav-frontend.onrender.com'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (!allowedOrigins.includes(origin)) {
      return callback(new Error('CORS blocked'), false);
    }
    return callback(null, true);
  },
  credentials: true
}));

app.use(express.json());

/* ================= SESSION ================= */
app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'none',
    maxAge: 1000 * 60 * 60
  }
}));

/* ================= AUTH ROUTES ================= */
app.get("/api/auth/me", (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ authenticated: true, user: req.session.user });
  }
  res.status(401).json({ authenticated: false });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
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
  } catch {
    res.status(500).json({ success: false });
  }
});

app.post('/api/events', requireAdminLogin, async (req, res) => {
  try {
    const db = getDb();
    const event = { ...req.body, createdAt: new Date(), status: 'upcoming' };
    await db.collection('events').insertOne(event);
    res.json({ success: true, event });
  } catch {
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
  } catch {
    res.status(500).json({ success: false });
  }
});

app.delete('/api/events/:id', requireAdminLogin, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('events').deleteOne({ id: req.params.id });
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false });
  }
});

/* ================= PAYMENT ================= */

/* CREATE ORDER */
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount } = req.body;

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`
    });

    res.json({ success: true, order });
  } catch (err) {
    console.error("Order error:", err);
    res.status(500).json({ success: false });
  }
});

/* VERIFY PAYMENT */
app.post('/api/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      eventTitle,
      name,
      email,
      formData
    } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Invalid payment" });
    }

    const db = getDb();
    const ticketId = `TICKET-${Date.now()}`;
    const timestamp = new Date();

    await db.collection('tickets').insertOne({
      _id: ticketId,
      event: eventTitle,
      primary_name: name,
      email,
      formData: formData || {},
      payment_id: razorpay_payment_id,
      status_day_1: 'pending',
      status_day_2: 'pending',
      createdAt: timestamp
    });

    await db.collection('form_responses').insertOne({
      ticketId,
      eventTitle,
      respondentName: name,
      respondentEmail: email,
      dynamicAttributes: formData || {},
      submittedAt: timestamp
    });

    sendTicketEmail({
      id: ticketId,
      event: eventTitle,
      primary_name: name,
      email
    }).catch(console.error);

    res.json({ success: true, ticketId });

  } catch (err) {
    console.error("Verify error:", err);
    res.status(500).json({ success: false });
  }
});

/* ================= ADMIN ================= */
app.get('/api/registrations', requireAdminLogin, async (req, res) => {
  try {
    const db = getDb();
    const tickets = await db.collection('tickets')
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ success: true, data: tickets });
  } catch {
    res.status(500).json({ success: false });
  }
});

/* ================= REACT SPA ROUTING ================= */
app.use(express.static(path.join(__dirname, 'build')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

/* ================= START ================= */
connectToDatabase().then(() => {
  app.listen(PORT, () =>
    console.log(`🚀 Server running on port ${PORT}`)
  );
});