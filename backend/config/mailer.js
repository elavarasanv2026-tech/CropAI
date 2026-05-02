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
    const supportEmail = getSupportEmail();
    const cleanedName = String(name || '').trim();
    const greeting = cleanedName ? `Hello, ${cleanedName}.` : 'Hello.';
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0f1117;margin:0;padding:0;width:100%;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;width:100%;background:#151515;border:1px solid #31343a;border-radius:18px;">
          <tr>
            <td style="padding:40px 28px 36px;">
              <div style="text-align:center;color:#dff6e8;font-size:30px;line-height:1.2;font-weight:400;margin:0 0 28px;">
                Welcome to <span style="color:#16a34a;">CropAI</span>
              </div>
              <div style="color:#d8dde7;font-size:18px;line-height:1.6;margin:0 0 22px;">${greeting}</div>
              <div style="color:#b7bfcb;font-size:18px;line-height:1.8;margin:0 0 30px;">
                Thanks for creating an account with CropAI. To complete your signup, please confirm that this email address belongs to you.
              </div>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 30px;">
                <tr>
                  <td align="center">
                    <a href="${verificationUrl}" style="display:inline-block;background:#19a84a;color:#ffffff;text-decoration:none;padding:16px 30px;border-radius:12px;font-size:18px;line-height:1.2;min-width:200px;text-align:center;box-sizing:border-box;">
                      Verify Email
                    </a>
                  </td>
                </tr>
              </table>
              <div style="color:#b7bfcb;font-size:17px;line-height:1.8;margin:0 0 18px;">
                After verification, you'll be able to log in and access your dashboard, get AI crop recommendations, and explore our tools for farming optimization.
              </div>
              <div style="color:#a2aab5;font-size:16px;line-height:1.8;margin:0 0 28px;">
                If you didn't sign up for CropAI, please ignore this message. No further action is required.
              </div>
              <div style="border-top:1px solid #2c2f35;padding-top:22px;text-align:center;color:#8b93a0;font-size:14px;line-height:1.8;">
                You are receiving this email because you registered at <a href="${process.env.APP_URL || 'http://localhost:3000'}" style="color:#16a34a;text-decoration:none;">CropAI</a>.<br>
                Need help? Contact CropAI Support<br>
                <a href="mailto:${supportEmail}" style="color:#16a34a;text-decoration:none;">${supportEmail}</a>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
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
