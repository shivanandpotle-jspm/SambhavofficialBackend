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

/* ================= CORS ================= */
app.use(cors({
  origin: [
    'http://localhost:8080',
    'https://sambhavofficial.in',
    'https://www.sambhavofficial.in',
    'https://sambhav-frontend.onrender.com'
  ],
  credentials: true
}));

/* =====================================================
   🔥 RAZORPAY WEBHOOK (MUST BE BEFORE express.json)
   ===================================================== */
app.post(
  '/api/razorpay-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      console.log('🔥 Razorpay webhook HIT');
      const signature = req.headers['x-razorpay-signature'];

      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(req.body)
        .digest('hex');

      if (signature !== expectedSignature) {
        console.error('❌ Invalid webhook signature');
        return res.status(400).send('Invalid signature');
      }
      console.log('✅ Razorpay webhook signature verified');
      
      const payload = JSON.parse(req.body.toString());
        console.log('📦 Webhook event:', payload.event);
      
      if (payload.event === 'payment.captured') {
        const payment = payload.payload.payment.entity;
         console.log('💰 Payment captured:', payment.id);
        const db = getDb();

        const exists = await db
          .collection('tickets')
          .findOne({ payment_id: payment.id });

        if (!exists) {
          const ticketId = `TICKET-${Date.now()}`;

const preReg = await db.collection('pre_registrations').findOne({
  email: payment.notes?.email,
  event: payment.notes?.eventTitle,
  status: 'pending_payment',
});

await db.collection('tickets').insertOne({
  _id: ticketId,
  event: payment.notes?.eventTitle || 'Unknown Event',
  primary_name: payment.notes?.name || 'Guest',
  email: payment.notes?.email,
  payment_id: payment.id,
  formData: preReg?.formData || {},
  createdAt: new Date(),
});

// optional but recommended cleanup
if (preReg) {
  await db.collection('pre_registrations').updateOne(
    { _id: preReg._id },
    { $set: { status: 'completed' } }
  );
}


          sendTicketEmail({
            id: ticketId,
            event: payment.notes?.eventTitle || 'Event',
            primary_name: payment.notes?.name || 'Guest',
            email: payment.notes?.email,
          }).catch(err => console.error('Email error:', err));
        }
      }

      return res.json({ status: 'ok' });
    } catch (err) {
      console.error('Webhook error:', err);
      return res.status(500).send('Webhook error');
    }
  }
);

/* ================= JSON PARSER (AFTER WEBHOOK) ================= */
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

const requireAdminLogin = (req, res, next) => {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Unauthorized' });
};

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

/* ================= REGISTRATIONS (ADMIN) ================= */
app.get('/api/registrations', requireAdminLogin, async (req, res) => {
  try {
    const tickets = await getDb()
      .collection('tickets')
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, data: tickets });
  } catch (err) {
    console.error('Registrations error:', err);
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

    return res.json({ success: true, order });
  } catch (err) {
    console.error('Order error:', err);
    return res.status(500).json({ success: false });
  }
});

/* ================= PRE-REGISTER (SAVE FORM DATA BEFORE PAYMENT) ================= */
app.post('/api/pre-register', async (req, res) => {
  try {
    const { eventTitle, name, email, formData } = req.body;

    if (!email || !eventTitle) {
      return res.status(400).json({ success: false });
    }

    const db = getDb();

    await db.collection('pre_registrations').insertOne({
      event: eventTitle,
      primary_name: name,
      email,
      formData,
      status: 'pending_payment',
      createdAt: new Date(),
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Pre-register error:', err);
    return res.status(500).json({ success: false });
  }
});


/* ================= VERIFY PAYMENT (FRONTEND) ================= */
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
      return res.status(400).json({ success: false, message: 'Invalid signature' });
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
      formData: formData || {},
      payment_id: razorpay_payment_id,
      status_day_1: 'pending',
      status_day_2: 'pending',
      createdAt: new Date()
    });

    sendTicketEmail({
      id: ticketId,
      event: eventTitle,
      primary_name: name,
      email
    }).catch(err => console.error('Email error:', err));

    return res.json({ success: true, ticketId });

  } catch (err) {
    console.error('Verify error:', err);
    return res.status(500).json({ success: false });
  }
});

/* ================= START ================= */
connectToDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});
