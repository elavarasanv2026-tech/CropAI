const sgMail = require('@sendgrid/mail');

function getSupportEmail() {
    return process.env.SUPPORT_EMAIL || process.env.FROM_EMAIL || process.env.EMAIL_FROM || 'support.cropai@gmail.com';
}

function getVerificationBaseUrl() {
    return String(process.env.BASE_URL || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

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
                You are receiving this email because you registered at <a href="${getVerificationBaseUrl()}" style="color:#16a34a;text-decoration:none;">CropAI</a>.<br>
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

async function sendVerificationEmail(toEmail, verificationToken, name = '') {
    try {
        const apiKey = String(process.env.SENDGRID_API_KEY || '').trim();
        const fromEmail = String(process.env.FROM_EMAIL || '').trim();

        if (!apiKey || !fromEmail) {
            console.error('[SENDGRID] failed missing SENDGRID_API_KEY or FROM_EMAIL');
            return false;
        }

        sgMail.setApiKey(apiKey);
        console.log('[SENDGRID] email sending');

        const verifyLink = `${getVerificationBaseUrl()}/api/verify-email?token=${verificationToken}`;
        const msg = {
            to: toEmail,
            from: fromEmail,
            subject: 'Verify your CropAI account',
            html: buildVerificationEmailHtml(verifyLink, name)
        };

        const response = await sgMail.send(msg);
        console.log('[SENDGRID] email sent', response[0].statusCode);
        return true;
    } catch (err) {
        console.error('[SENDGRID] failed', err.message);
        return false;
    }
}

module.exports = {
    buildVerificationEmailHtml,
    sendVerificationEmail
};
