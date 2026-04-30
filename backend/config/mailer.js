const nodemailer = require('nodemailer');

/**
 * Creates a Gmail SMTP transporter using EMAIL_USER and EMAIL_PASS from .env
 */
function getSupportEmail() {
    return process.env.SUPPORT_EMAIL || process.env.EMAIL_FROM || process.env.EMAIL_USER || 'support.cropai@gmail.com';
}

function getSmtpAuthUser() {
    return process.env.SMTP_AUTH_USER || process.env.EMAIL_USER;
}

function getSmtpAuthPass() {
    return process.env.SMTP_AUTH_PASS || process.env.EMAIL_PASS;
}

function createTransporter() {
    const user = getSmtpAuthUser();
    const pass = getSmtpAuthPass();

    if (!user || !pass) {
        return null;
    }

    return nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user, pass }
    });

    return { sent: true };
}

/**
 * Builds a beautiful, Phytelix-style HTML verification email.
 */
function buildVerificationEmailHtml(verificationUrl, name = '') {
    const greeting = name ? `Hello, ${name}!` : 'Hello!';
    const supportEmail = getSupportEmail();
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,0.05);border:1px solid #eef2f6;">
    <div style="padding:40px;text-align:center;">
      <h1 style="margin:0;color:#0d2b1a;font-size:28px;font-weight:700;">Welcome to <span style="color:#16a34a;">CropAI</span></h1>
    </div>
    <div style="padding:0 40px 40px;">
      <p style="margin:0 0 15px;color:#334155;font-size:16px;">Hello,</p>
      <p style="margin:0 0 25px;color:#475569;font-size:15px;line-height:1.7;">
        Thanks for creating an account with <strong>CropAI</strong>. To complete your signup, please confirm that this email address belongs to you.
      </p>
      <div style="text-align:center;margin:35px 0;">
        <a href="${verificationUrl}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;padding:16px 45px;border-radius:8px;font-weight:700;font-size:16px;">
          Verify Email
        </a>
      </div>
      <p style="margin:0 0 15px;color:#64748b;font-size:14px;line-height:1.7;">
        After verification, you'll be able to log in and access your dashboard, get AI crop recommendations, and explore our tools for farming optimization.
      </p>
      <p style="margin:0 0 30px;color:#64748b;font-size:14px;">
        If you didn't sign up for CropAI, please ignore this message. No further action is required.
      </p>
      <hr style="border:none;border-top:1px solid #f1f5f9;margin:30px 0;">
      <p style="text-align:center;color:#94a3b8;font-size:13px;margin:0;">
        You are receiving this email because you registered at <a href="${process.env.APP_URL || 'http://localhost:3000'}" style="color:#16a34a;text-decoration:none;">cropai.com</a>.<br>
        Need help? Contact CropAI Support<br>
        <a href="mailto:${supportEmail}" style="color:#16a34a;text-decoration:none;">${supportEmail}</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Sends a verification email to a newly registered user.
 * @param {string} toEmail - Recipient email address
 * @param {string} verificationToken - The raw crypto token (not JWT)
 * @param {string} [name] - Optional user name for personalised greeting
 */
async function sendVerificationEmail(toEmail, verificationToken, name = '') {
    const transporter = createTransporter();
    if (!transporter) {
        return { sent: false, reason: 'email_not_configured' };
    }

    const baseUrl = process.env.APP_URL || process.env.BASE_URL || 'http://localhost:3000';
    const verificationUrl = `${baseUrl}/verify.html?token=${verificationToken}`;
    const supportEmail = getSupportEmail();

    await transporter.sendMail({
        from: `"CropAI" <${process.env.EMAIL_FROM || supportEmail}>`,
        replyTo: supportEmail,
        to: toEmail,
        subject: 'Verify your email – Welcome to CropAI 🌱',
        html: buildVerificationEmailHtml(verificationUrl, name)
    });
}

module.exports = {
    createTransporter,
    buildVerificationEmailHtml,
    sendVerificationEmail
};
