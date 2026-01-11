/**
 * dotenv MUST be first
 */
require('dotenv').config();

/* ================= IMPORTS ================= */
const express = require('express');
const session = require('express-session');
const Razorpay = require('razorpay');
const cors = require('cors');

const { connectToDatabase, getDb } = require('./database');
const { requireAdminLogin } = require('./auth');
const { sendTicketEmail } = require('./email');

/* ================= APP ================= */
const app = express();
const PORT = process.env.PORT || 5000;

/* ================= TRUST PROXY (RENDER REQUIRED) ================= */
app.set("trust proxy", 1);

/* ================= RAZORPAY ================= */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* ================= MIDDLEWARE ================= */
app.use(
  cors({
    origin: true,          // allow frontend on Render
    credentials: true,
  })
);

app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: true,        // REQUIRED for HTTPS (Render)
      httpOnly: true,
      sameSite: "none",    // REQUIRED for cross-site cookies
      maxAge: 1000 * 60 * 60, // 1 hour
    },
  })
);

/* =====================================================
   AUTHENTICATION & LOGIN
===================================================== */

/**
 * 🔑 AUTH CHECK
 */
app.get("/api/auth/me", (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ authenticated: true, user: req.session.user });
  }
  res.status(401).json({ authenticated: false });
});

/**
 * 🚪 ADMIN LOGIN
 */
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

/**
 * 🏃 ADMIN LOGOUT
 */
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid", { path: "/" });
    res.json({ success: true });
  });
});

/* =====================================================
   EVENTS
===================================================== */

app.get("/api/events", async (req, res) => {
  try {
    const db = getDb();
    const events = await db.collection('events').find({}).toArray();
    res.json({ success: true, events });
  } catch (err) {
    console.error("FETCH EVENTS ERROR:", err);
    res.status(500).json({ success: false });
  }
});

app.post('/api/events', requireAdminLogin, async (req, res) => {
  try {
    const db = getDb();
    const event = {
      ...req.body,
      createdAt: new Date(),
      status: 'upcoming',
    };

    await db.collection('events').insertOne(event);
    res.json({ success: true, event });
  } catch (err) {
    console.error('CREATE EVENT ERROR:', err);
    res.status(500).json({ success: false });
  }
});

app.put('/api/events/:id', requireAdminLogin, async (req, res) => {
  try {
    const db = getDb();
    await db.collection('events').updateOne(
      { id: req.params.id },
      { $set: req.body }
    );
    res.json({ success: true });
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

/* =====================================================
   PAYMENT → TICKET → EMAIL
===================================================== */
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_payment_id, eventTitle, name, email, formData } = req.body;

    if (!razorpay_payment_id || !name || !email) {
      return res.status(400).json({ success: false });
    }

    const ticketId = `TICKET-${Date.now()}`;
    const db = getDb();

    await db.collection('tickets').insertOne({
      _id: ticketId,
      event: eventTitle,
      primary_name: name,
      email,
      formData: formData || {},
      payment_id: razorpay_payment_id,
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

    res.json({ success: true, ticketId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

/* =====================================================
   REGISTRATIONS
===================================================== */
app.get('/api/registrations', requireAdminLogin, async (req, res) => {
  try {
    const db = getDb();
    const tickets = await db
      .collection('tickets')
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, data: tickets });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

/* =====================================================
   QR SCANNING
===================================================== */
app.post('/api/validate-ticket/:id', requireAdminLogin, async (req, res) => {
  try {
    const db = getDb();
    const { id } = req.params;
    const { day } = req.query;

    if (!day || (day !== '1' && day !== '2')) {
      return res.status(400).json({ success: false });
    }

    const ticket = await db.collection('tickets').findOne({ _id: id });
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Invalid Ticket' });
    }

    const field = day === '1' ? 'status_day_1' : 'status_day_2';

    if (ticket[field] === 'checked-in') {
      return res.json({
        success: false,
        message: 'Already checked-in',
      });
    }

    await db.collection('tickets').updateOne(
      { _id: id },
      { $set: { [field]: 'checked-in' } }
    );

    res.json({
      success: true,
      message: 'Check-in successful',
      ticket: { name: ticket.primary_name, event: ticket.event },
    });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

/* ================= START SERVER ================= */
connectToDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Backend running on port ${PORT}`);
  });
});
