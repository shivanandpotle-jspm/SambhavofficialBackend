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

/* ================= RAZORPAY ================= */
new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* ================= MIDDLEWARE ================= */
app.use(
  cors({
    origin: 'http://localhost:8080',
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
      secure: false,       // localhost = false
      httpOnly: true,
      sameSite: 'lax',     // ⭐ THIS IS THE KEY
      maxAge: 1000 * 60 * 60,
    },
  })
);


/* ================= ADMIN LOGIN ================= */
app.post('/api/login', (req, res) => {
  // you can add username/password check later
  req.session.user = {
    id: 'admin',
    role: 'admin',
  };

  res.json({
    success: true,
    user: req.session.user,
  });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});


/* =====================================================
   EVENTS (SOURCE OF TRUTH = DATABASE)
===================================================== */

/* ➕ CREATE EVENT */
app.post('/api/events', async (req, res) => {
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

/* 📥 GET ALL EVENTS */
app.get("/api/auth/me", (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ authenticated: true, user: req.session.user });
  }
  res.status(401).json({ authenticated: false });
});


/* ✏️ UPDATE EVENT */
app.put('/api/events/:id',requireAdminLogin, async (req, res) => {
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

/* 🗑️ DELETE EVENT */
app.delete('/api/events/:id',requireAdminLogin, async (req, res) => {
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
   REGISTRATIONS (ADMIN PAGE)
===================================================== */
app.get('/api/registrations',requireAdminLogin, async (req, res) => {
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
   QR SCANNING (NO LOGIN REQUIRED)
===================================================== */
app.post('/api/validate-ticket/:id',requireAdminLogin, async (req, res) => {
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
