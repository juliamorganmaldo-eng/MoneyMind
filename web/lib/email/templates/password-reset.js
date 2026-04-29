// Password reset email. Sent in both HTML and plaintext.
// Template input: { user_email, reset_url, expires_in_minutes }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function build({ user_email, reset_url, expires_in_minutes }) {
  const subject = 'Reset your MoneyMind password';
  const escapedUrl = escapeHtml(reset_url);
  const escapedEmail = escapeHtml(user_email);

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F0FDF4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#0B1F14;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0FDF4;padding:40px 20px;">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid #E5E7EB;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-weight:700;color:#14532D;font-size:18px;margin-bottom:24px;">◆ MoneyMind</div>
          <h1 style="margin:0 0 16px 0;font-size:22px;color:#0B1F14;">Reset your password</h1>
          <p style="margin:0 0 16px 0;line-height:1.5;color:#1F2937;">
            We received a request to reset the password for the account
            <strong>${escapedEmail}</strong>.
          </p>
          <p style="margin:0 0 24px 0;line-height:1.5;color:#1F2937;">
            Click the button below to choose a new password. This link expires in ${expires_in_minutes} minutes.
          </p>
          <p style="margin:0 0 24px 0;text-align:center;">
            <a href="${escapedUrl}"
               style="display:inline-block;padding:12px 24px;background:#14532D;color:#FFFFFF;text-decoration:none;border-radius:8px;font-weight:600;">
              Reset password
            </a>
          </p>
          <p style="margin:0 0 16px 0;font-size:13px;color:#6B7280;">
            If the button doesn't work, copy and paste this URL into your browser:
            <br>
            <a href="${escapedUrl}" style="color:#15803D;word-break:break-all;">${escapedUrl}</a>
          </p>
          <p style="margin:24px 0 0 0;font-size:13px;color:#6B7280;">
            If you didn't ask to reset your password, you can safely ignore this email — your account stays exactly as it was.
          </p>
          <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0;">
          <p style="margin:0;font-size:12px;color:#6B7280;">
            MoneyMind is a personal project — please don't reply to this email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    'Reset your MoneyMind password',
    '',
    `We received a request to reset the password for ${user_email}.`,
    '',
    `Click this link to choose a new password (expires in ${expires_in_minutes} minutes):`,
    reset_url,
    '',
    `If you didn't ask to reset your password, you can safely ignore this email — your account stays exactly as it was.`,
    '',
    '— MoneyMind',
    `MoneyMind is a personal project — please don't reply to this email.`,
  ].join('\n');

  return { subject, html, text };
}

module.exports = { build };
