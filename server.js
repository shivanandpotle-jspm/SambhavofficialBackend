require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');

const { connectToDatabase, getDb } = require('./database');
const { sendTicketEmail } = require('./email');

const app = express();
const PORT = process.env.PORT || 5000;

/* ================= RAZORPAY ================= */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* ================= WEBHOOK (MUST BE FIRST) ================= */
app.post(
  '/api/webhook/razorpay',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      const signature = req.headers['x-razorpay-signature'];

      const expected = crypto
        .createHmac('sha256', secret)
        .update(req.body)
        .digest('hex');

      if (signature !== expected) {
        console.error('❌ Invalid webhook signature');
        return res.status(400).send('Invalid signature');
      }

      const event = JSON.parse(req.body.toString());

      if (event.event === 'payment.captured') {
        const payment = event.payload.payment.entity;
        const db = getDb();

        console.log('🔥 payment.captured:', payment.id);

        // Prevent duplicate tickets
        const existing = await db
          .collection('tickets')
          .findOne({ payment_id: payment.id });

        if (existing) {
          console.log('⚠️ Duplicate ignored:', payment.id);
          return res.json({ status: 'duplicate' });
        }

        const ticketId = `TICKET-${Date.now()}`;

        const email =
          payment.email ||
          payment.notes?.email;

        const name =
          payment.notes?.name || 'Participant';

        const eventTitle =
          payment.notes?.eventTitle || 'Event';

        await db.collection('tickets').insertOne({
          _id: ticketId,
          event: eventTitle,
          primary_name: name,
          email,
          payment_id: payment.id,
          status_day_1: 'pending',
          status_day_2: 'pending',
          createdAt: new Date(),
        });

        await sendTicketEmail({
          id: ticketId,
          event: eventTitle,
          primary_name: name,
          email,
        });

        console.log('✅ Ticket sent:', ticketId);
      }

      res.json({ status: 'ok' });
    } catch (err) {
      console.error('❌ Webhook error:', err);
      res.status(500).send('Webhook error');
    }
  }
);

/* ================= MIDDLEWARE ================= */
app.use(cors({
  origin: [
    'http://localhost:8080',
    'https://sambhavofficial.in',
    'https://www.sambhavofficial.in',
    'https://sambhav-frontend.onrender.com',
  ],
  credentials: true,
}));

app.use(express.json());

/* ================= SESSION ================= */
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'sambhav_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    sameSite: 'none',
  },
}));

/* ================= EVENTS ================= */
app.get('/api/events', async (req, res) => {
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
    const { amount, name, email, eventTitle } = req.body;

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`,
      notes: {
        name,
        email,
        eventTitle,
      },
    });

    res.json({ success: true, order });
  } catch (err) {
    console.error('Order error:', err);
    res.status(500).json({ success: false });
  }
});

/* ================= START ================= */
connectToDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});