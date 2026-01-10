const sgMail = require('@sendgrid/mail');
const QRCode = require('qrcode');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
require('dotenv').config();

// Set the SendGrid API key from your .env file
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function createTicketPDF(booking) {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]);
    const { width, height } = page.getSize();
    
    // Embed standard fonts for the PDF
    const poppinsFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const poppinsBoldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Generate the QR Code based on the unique Ticket ID
    const qrCodeDataURL = await QRCode.toDataURL(booking.id);
    const qrImageBytes = Buffer.from(qrCodeDataURL.split(',')[1], 'base64');
    const qrImage = await pdfDoc.embedPng(qrImageBytes);
    
    // Draw Ticket Header
    page.drawText('Event Ticket', { x: 50, y: height - 70, font: poppinsBoldFont, size: 36, color: rgb(0.1, 0.1, 0.1) });
    page.drawText('Sambhav Club', { x: 50, y: height - 100, font: poppinsFont, size: 18, color: rgb(0.3, 0.3, 0.3) });
    page.drawImage(qrImage, { x: width - 200, y: height - 220, width: 150, height: 150 });

    // Draw Event and Attendee Details
    const startY = height - 180;
    page.drawText('EVENT:', { x: 50, y: startY, font: poppinsBoldFont, size: 12 });
    page.drawText(booking.event, { x: 50, y: startY - 20, font: poppinsFont, size: 16 });
    
    page.drawText('ATTENDEE:', { x: 50, y: startY - 60, font: poppinsBoldFont, size: 12 });
    page.drawText(booking.primary_name, { x: 50, y: startY - 80, font: poppinsFont, size: 14 });

    page.drawText('TICKET ID:', { x: 50, y: startY - 120, font: poppinsBoldFont, size: 12 });
    page.drawText(booking.id, { x: 50, y: startY - 140, font: poppinsFont, size: 10 });
    
    return await pdfDoc.save();
}

async function sendTicketEmail(booking) {
    try {
        const ticketPdfBytes = await createTicketPDF(booking);
        const pdfBase64 = Buffer.from(ticketPdfBytes).toString('base64');

        const msg = {
            to: booking.email,
            from: process.env.VERIFIED_SENDER_EMAIL, // Your verified SendGrid sender
            subject: `Your Ticket for ${booking.event}`,
            html: `
                <p>Hi ${booking.primary_name},</p>
                <p>Thank you for registering! Your ticket for <strong>${booking.event}</strong> is attached to this email.</p>
                <p>Please have the QR code ready for scanning at the event entrance.</p>
                <br>
                <p>Best regards,</p>
                <p><strong>The Sambhav Club Team</strong></p>
            `,
            attachments: [
                {
                    content: pdfBase64,
                    filename: `ticket-${booking.id}.pdf`,
                    type: 'application/pdf',
                    disposition: 'attachment',
                },
            ],
        };

        await sgMail.send(msg);
        console.log(`✅ Email sent successfully to ${booking.email}`);
    } catch (error) {
        console.error(`❌ Failed to send email to ${booking.email}:`, error);
        throw new Error('Failed to send ticket email.');
    }
}

module.exports = { sendTicketEmail };