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

/* ================= WEBHOOK (RAW BODY — MUST BE FIRST) ================= */
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

        // Prevent duplicate ticket
        const alreadyIssued = await db.collection('tickets')
          .findOne({ payment_id: payment.id });

        if (!alreadyIssued) {
          const pending = await db.collection('pending_payments')
            .findOne({ razorpay_order_id: payment.order_id });

          if (pending) {
            const ticketId = `TICKET-${Date.now()}`;

            await db.collection('tickets').insertOne({
              _id: ticketId,
              event: pending.eventTitle,
              primary_name: pending.name,
              email: pending.email,
              formData: pending.formData || {},
              payment_id: payment.id,
              status_day_1: 'pending',
              status_day_2: 'pending',
              createdAt: new Date()
            });

            await sendTicketEmail({
              id: ticketId,
              event: pending.eventTitle,
              primary_name: pending.name,
              email: pending.email
            });

            await db.collection('pending_payments')
              .deleteOne({ _id: pending._id });
          }
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

/* VERIFY PAYMENT — NOW ONLY SAVES PENDING */
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

    await db.collection('pending_payments').insertOne({
      razorpay_order_id,
      razorpay_payment_id,
      eventTitle,
      name,
      email,
      formData: formData || {},
      status: 'pending',
      createdAt: new Date()
    });

    res.json({
      success: true,
      message: 'Payment verified. Ticket will be sent shortly.'
    });

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