require('dotenv').config();
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const msg = {
  to: 'rajp91881@gmail.com',          // 👈 recipient
  from: process.env.VERIFIED_SENDER_EMAIL, // 👈 MUST be verified
  subject: 'SendGrid Test – Sambhav',
  text: 'This is a SendGrid test email',
  html: '<strong>SendGrid is working!</strong>',
};

sgMail
  .send(msg)
  .then(() => {
    console.log('✅ Email sent successfully');
  })
  .catch((error) => {
    console.error('❌ SendGrid Error:', error.response?.body || error);
  });
