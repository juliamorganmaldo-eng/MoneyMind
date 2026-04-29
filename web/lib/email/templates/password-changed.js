// Confirmation email after a successful password change. Sent so the user
// is alerted if it wasn't them.
// Template input: { user_email, when_iso }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function build({ user_email, when_iso }) {
  const subject = 'Your MoneyMind password was changed';
  const escapedEmail = escapeHtml(user_email);
  const escapedWhen  = escapeHtml(when_iso);

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F0FDF4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#0B1F14;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0FDF4;padding:40px 20px;">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid #E5E7EB;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-weight:700;color:#14532D;font-size:18px;margin-bottom:24px;">◆ MoneyMind</div>
          <h1 style="margin:0 0 16px 0;font-size:22px;color:#0B1F14;">Your password was changed</h1>
          <p style="margin:0 0 16px 0;line-height:1.5;color:#1F2937;">
            The password for <strong>${escapedEmail}</strong> was changed at <strong>${escapedWhen}</strong>.
            All existing sessions have been signed out.
          </p>
          <p style="margin:0 0 16px 0;line-height:1.5;color:#1F2937;">
            If this was you, no action needed.
          </p>
          <p style="margin:0 0 16px 0;line-height:1.5;color:#9B2C2C;">
            <strong>If this wasn't you</strong>, your account may be compromised — reset your password
            again immediately and review your connected banks.
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
    'Your MoneyMind password was changed',
    '',
    `The password for ${user_email} was changed at ${when_iso}.`,
    'All existing sessions have been signed out.',
    '',
    'If this was you, no action needed.',
    `If this wasn't you, your account may be compromised — reset your password again immediately`,
    'and review your connected banks.',
    '',
    '— MoneyMind',
    `MoneyMind is a personal project — please don't reply to this email.`,
  ].join('\n');

  return { subject, html, text };
}

module.exports = { build };
