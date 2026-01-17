require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');

const { connectToDatabase, getDb } = require('./database');
const { sendTicketEmail } = require('./email');

const app = express();
const PORT = process.env.PORT || 5000;

/* ================= RAZORPAY ================= */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* ================= MIDDLEWARE ================= */
app.use(cors({
  origin: [
    'http://localhost:8080',
    'https://sambhavofficial.in',
    'https://www.sambhavofficial.in',
    'https://sambhav-frontend.onrender.com'
  ],
  credentials: true
}));

app.use(express.json());

app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'sambhav-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    httpOnly: true,
    sameSite: 'none',
    maxAge: 1000 * 60 * 60
  }
}));

/* ================= ADMIN AUTH ================= */
app.get('/api/auth/me', (req, res) => {
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

  res.status(401).json({ success: false, message: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

/* ================= EVENTS ================= */
app.get('/api/events', async (req, res) => {
  try {
    const events = await getDb().collection('events').find({}).toArray();
    res.json({ success: true, events });
  } catch {
    res.status(500).json({ success: false });
  }
});

app.get('/events', async (req, res) => {
  try {
    const events = await getDb().collection('events').find({}).toArray();
    res.json({ success: true, events });
  } catch {
    res.status(500).json({ success: false });
  }
});

/* ================= CREATE ORDER ================= */
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, name, email, eventTitle } = req.body;

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: 'INR',
      payment_capture: 1,
      receipt: `rcpt_${Date.now()}`,
      notes: { name, email, eventTitle }
    });

    res.json({ success: true, order });
  } catch (err) {
    console.error('Order error:', err);
    res.status(500).json({ success: false });
  }
});

/* ================= VERIFY PAYMENT ================= */
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

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false });
    }

    const db = getDb();

    const alreadyExists = await db
      .collection('tickets')
      .findOne({ payment_id: razorpay_payment_id });

    if (alreadyExists) {
      return res.json({ success: true, ticketId: alreadyExists._id });
    }

    const ticketId = `TICKET-${Date.now()}`;

    await db.collection('tickets').insertOne({
      _id: ticketId,
      event: eventTitle,
      primary_name: name,
      email,
      formData,
      payment_id: razorpay_payment_id,
      status_day_1: 'pending',
      status_day_2: 'pending',
      createdAt: new Date()
    });

    await sendTicketEmail({
      id: ticketId,
      event: eventTitle,
      primary_name: name,
      email
    });

    res.json({ success: true, ticketId });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ success: false });
  }
});

/* ================= START ================= */
connectToDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});