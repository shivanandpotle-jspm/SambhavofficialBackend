require('dotenv').config();
const express = require('express');
const session = require('express-session');
const Razorpay = require('razorpay');
const crypto = require('crypto'); // ✅ NEW
const cors = require('cors');

const { connectToDatabase, getDb } = require('./database');
const { requireAdminLogin } = require('./auth');
const { sendTicketEmail } = require('./email');

const app = express();
const PORT = process.env.PORT || 5000;

/* ================= RAZORPAY INSTANCE (FIXED) ================= */
// ❗ Previously instance was created but not stored
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* ================= CORS (UNCHANGED) ================= */
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
      return callback(new Error('CORS block'), false);
    }
    return callback(null, true);
  }, 
  credentials: true 
}));

app.use(express.json());

/* ================= SESSION (UNCHANGED) ================= */
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

/* ================= AUTH ROUTES (UNCHANGED) ================= */
// ... (NO CHANGES)

/* ================= EVENT ROUTES (UNCHANGED) ================= */
// ... (NO CHANGES)

/* ============================================================
   ✅ NEW: CREATE ORDER API (REQUIRED FOR VERIFICATION)
   ============================================================ */
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount } = req.body;

    const order = await razorpay.orders.create({
      amount: amount * 100, // INR → paise
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`
    });

    res.json({ success: true, order });
  } catch (err) {
    console.error('Order creation error:', err);
    res.status(500).json({ success: false });
  }
});

/* ============================================================
   ✅ FIXED: PAYMENT VERIFICATION (ONLY LOGIC CHANGE)
   ============================================================ */
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

    // ✅ STEP 1: VERIFY SIGNATURE
    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Invalid payment' });
    }

    // ✅ STEP 2: PAYMENT VERIFIED — NOW ISSUE TICKET
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

    // ✅ STEP 3: SEND EMAIL AFTER VERIFICATION
    sendTicketEmail({
      id: ticketId,
      event: eventTitle,
      primary_name: name,
      email
    }).catch(err => console.error('Email error:', err));

    res.json({ success: true, ticketId });

  } catch (err) {
    console.error('Verify payment error:', err);
    res.status(500).json({ success: false });
  }
});

/* ================= ADMIN REGISTRATIONS (UNCHANGED) ================= */
app.get('/api/registrations', requireAdminLogin, async (req, res) => {
  try {
    const db = getDb();
    const tickets = await db.collection('tickets').find({}).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, data: tickets });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

/* ================= START SERVER ================= */
connectToDatabase().then(() => {
  app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
});