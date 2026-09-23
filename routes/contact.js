const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
// 2026-09-23: this route carried its own SendGrid client. The stored key had
// been answering 401 for who knows how long — every contact-form submission
// "sent" and then failed in the catch. It now rides the shared transport in
// emailService (Resend → SendGrid → Gmail, see buildTransport), so whichever
// path delivers verification codes delivers these too.
const emailService = require('../services/emailService');
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { email, subject, message } = req.body;
    const userId = req.user.id;
    const userName = req.user.name || 'User';
    console.log('📧 Contact form submission received:', { email, subject, userId });
    if (!email || !subject || !message) {
      return res.status(400).json({ error: 'Missing required fields', message: 'Email, subject, and message are required' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {return res.status(400).json({ error: 'Invalid email format' })}
    const supportTo = process.env.SUPPORT_EMAIL || process.env.MAIL_FROM || process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_USER;
    if (!supportTo) {
      console.error('❌ No support mailbox configured (SUPPORT_EMAIL)');
      return res.status(500).json({error: 'Email service not configured',message: 'Please contact the administrator'});
    }
    const msg = {
      to: supportTo,
      from: `"Jinni Support" <${emailService.transporter.from || supportTo}>`,
      replyTo: email,
      subject: `[Jinni Contact] ${subject}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff;">
          
          <div style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); padding: 30px 20px; text-align: center;">
            <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700;">Jinni</h1>
            <p style="color: rgba(255, 255, 255, 0.9); margin: 10px 0 0 0; font-size: 14px;">New Contact Form Submission</p>
          </div>
          
          <div style="background: #f8f9fa; padding: 25px 20px; border-bottom: 1px solid #e9ecef;">
            <div style="margin-bottom: 12px;">
              <span style="color: #6c757d; font-size: 13px; font-weight: 600; text-transform: uppercase;">From</span>
              <p style="margin: 5px 0 0 0; color: #212529; font-size: 16px; font-weight: 500;">${esc(userName)}</p>
              <p style="margin: 3px 0 0 0; color: #495057; font-size: 14px;">
                <a href="mailto:${esc(email)}" style="color: #8b5cf6; text-decoration: none;">${esc(email)}</a>
              </p>
            </div>
            <div style="margin-top: 15px;">
              <span style="color: #6c757d; font-size: 13px; font-weight: 600; text-transform: uppercase;">User ID</span>
              <p style="margin: 5px 0 0 0; color: #495057; font-size: 14px; font-family: monospace;">${esc(userId)}</p>
            </div>
            <div style="margin-top: 15px;">
              <span style="color: #6c757d; font-size: 13px; font-weight: 600; text-transform: uppercase;">Category</span>
              <p style="margin: 5px 0 0 0; color: #495057; font-size: 14px; text-transform: capitalize;">${esc(subject.replace(/-/g, ' '))}</p>
            </div>
          </div>
          
          <div style="padding: 30px 20px;">
            <div style="background: #ffffff; border-left: 4px solid #8b5cf6; padding: 20px; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
              <h3 style="margin: 0 0 15px 0; color: #212529; font-size: 16px; font-weight: 600;">Message:</h3>
              <p style="margin: 0; color: #495057; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">${esc(message)}</p>
            </div>
          </div>
          
          <div style="background: #f8f9fa; padding: 20px; border-top: 1px solid #e9ecef; text-align: center;">
            <p style="margin: 0; color: #6c757d; font-size: 12px;">
              Submitted on ${new Date().toLocaleString('en-US', { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
              })}
            </p>
            <p style="margin: 10px 0 0 0; color: #6c757d; font-size: 12px;">
              This message was sent from the Jinni contact form.
            </p>
          </div>
          
        </div>
      `,
      text: `
        New Contact Form Submission - Jinni

        FROM: ${userName}
        EMAIL: ${email}
        USER ID: ${userId}
        CATEGORY: ${subject}

        MESSAGE:
        ${message}

        ---
        Submitted on: ${new Date().toLocaleString()}`
    };
    await emailService.transporter.sendMail(msg);
    res.status(200).json({ success: true, message: 'Message sent successfully. We\'ll get back to you soon!'  });
  } catch (error) {
    console.error('❌ Contact form error:', error);
    if (error.response) console.error('Mail provider response:', error.response.body);
    if (error.code === 401 || error.code === 403 || /\b40[13]\b/.test(error.message || '')) {
      return res.status(500).json({ error: 'Email service authentication failed', message: 'Please contact support' });
    }
    res.status(500).json({ error: 'Failed to send message', message: 'Please try again later' });
  }
});

module.exports = router;