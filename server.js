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

/* ================= WEBHOOK (RAW BODY) ================= */
app.post(
  '/api/webhook/razorpay',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      const signature = req.headers['x-razorpay-signature'];

      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(req.body)
        .digest('hex');

      if (signature !== expectedSignature) {
        return res.status(400).send('Invalid signature');
      }

      const event = JSON.parse(req.body.toString());

      if (event.event === 'payment.captured') {
        const payment = event.payload.payment.entity;
        const db = getDb();

        const alreadyExists = await db.collection('tickets')
          .findOne({ payment_id: payment.id });

        if (!alreadyExists) {
          // fallback only (frontend failed)
          await db.collection('tickets').insertOne({
            _id: `TICKET-${Date.now()}`,
            event: 'Unknown (webhook fallback)',
            primary_name: 'Unknown',
            email: 'unknown@example.com',
            payment_id: payment.id,
            status_day_1: 'pending',
            status_day_2: 'pending',
            createdAt: new Date()
          });
        }
      }

      res.json({ status: 'ok' });
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).send('Webhook failure');
    }
  }
);

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

/* ================= EVENTS API ================= */
app.get('/api/events', async (req, res) => {
  try {
    const db = getDb();
    const events = await db.collection('events').find({}).toArray();
    res.json({ success: true, events });
  } catch {
    res.status(500).json({ success: false });
  }
});

// ✅ direct access (important for frontend routing)
app.get('/events', async (req, res) => {
  try {
    const db = getDb();
    const events = await db.collection('events').find({}).toArray();
    res.json({ success: true, events });
  } catch {
    res.status(500).json({ success: false });
  }
});

/* ================= CREATE ORDER ================= */
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
    console.error('Order error:', err);
    res.status(500).json({ success: false });
  }
});

/* ================= VERIFY PAYMENT (MAIN LOGIC) ================= */
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
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Invalid payment' });
    }

    const db = getDb();

    // 🔒 idempotency
    const existing = await db.collection('tickets')
      .findOne({ payment_id: razorpay_payment_id });

    if (existing) {
      return res.json({ success: true, ticketId: existing._id });
    }

    const ticketId = `TICKET-${Date.now()}`;

    await db.collection('tickets').insertOne({
      _id: ticketId,
      event: eventTitle,
      primary_name: name,
      email,
      formData: formData || {},
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

/* ================= START SERVER ================= */
connectToDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});