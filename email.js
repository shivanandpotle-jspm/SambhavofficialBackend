const sgMail = require('@sendgrid/mail');
const QRCode = require('qrcode');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
require('dotenv').config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function createTicketPDF(booking) {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]);
    const { width, height } = page.getSize();
    
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Convert all fields to strings to avoid undefined errors
    const ticketId = String(booking.id || "N/A");
    const eventName = String(booking.event || "Event");
    const name = String(booking.primary_name || "Guest");

    const qrCodeDataURL = await QRCode.toDataURL(ticketId);
    const qrImageBytes = Buffer.from(qrCodeDataURL.split(',')[1], 'base64');
    const qrImage = await pdfDoc.embedPng(qrImageBytes);
    
    page.drawText('Event Ticket', { x: 50, y: height - 70, font: boldFont, size: 36 });
    page.drawText('Sambhav Club', { x: 50, y: height - 100, font: font, size: 18 });
    page.drawImage(qrImage, { x: width - 200, y: height - 220, width: 150, height: 150 });

    page.drawText('EVENT:', { x: 50, y: height - 180, font: boldFont, size: 12 });
    page.drawText(eventName, { x: 50, y: height - 200, font: font, size: 16 });
    
    page.drawText('ATTENDEE:', { x: 50, y: height - 240, font: boldFont, size: 12 });
    page.drawText(name, { x: 50, y: height - 260, font: font, size: 14 });

    page.drawText('TICKET ID:', { x: 50, y: height - 300, font: boldFont, size: 12 });
    page.drawText(ticketId, { x: 50, y: height - 320, font: font, size: 10 });
    
    return await pdfDoc.save();
}

async function sendTicketEmail(booking) {
    try {
        const ticketPdfBytes = await createTicketPDF(booking);
        const msg = {
            to: booking.email,
            from: process.env.VERIFIED_SENDER_EMAIL,
            subject: `Your Ticket for ${booking.event}`,
            html: `<p>Hi ${booking.primary_name},</p><p>Your ticket for ${booking.event} is attached.</p>`,
            attachments: [{
                content: Buffer.from(ticketPdfBytes).toString('base64'),
                filename: `ticket-${booking.id}.pdf`,
                type: 'application/pdf',
                disposition: 'attachment',
            }],
        };
        await sgMail.send(msg);
        console.log(`✅ Ticket emailed to ${booking.email}`);
    } catch (error) {
        console.error(`❌ Email failed:`, error);
        throw error;
    }
}

module.exports = { sendTicketEmail };
