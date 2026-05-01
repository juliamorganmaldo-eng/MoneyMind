// Security alert email — sent when failed_login_attempts crosses the
// account-wide threshold (20 failures against this user's email in the
// last hour). Throttled to at most 1 per user per hour by a write to
// security_alerts_sent.
//
// Template input: { user_email, failed_count, window_minutes,
//                   forgot_password_url }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function build({ user_email, failed_count, window_minutes, forgot_password_url }) {
  const subject = 'MoneyMind: Unusual sign-in activity on your account';
  const escapedUrl = escapeHtml(forgot_password_url);
  const escapedEmail = escapeHtml(user_email);
  const escapedCount = escapeHtml(failed_count);
  const escapedWindow = escapeHtml(window_minutes);

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#FEF2F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#0B1F14;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#FEF2F2;padding:40px 20px;">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid #FCA5A5;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-weight:700;color:#14532D;font-size:18px;margin-bottom:24px;">◆ MoneyMind</div>
          <h1 style="margin:0 0 16px 0;font-size:22px;color:#7F1D1D;">Unusual sign-in activity</h1>
          <p style="margin:0 0 16px 0;line-height:1.5;color:#1F2937;">
            We've seen <strong>${escapedCount}</strong> failed sign-in attempts for
            <strong>${escapedEmail}</strong> in the last ${escapedWindow} minutes.
          </p>
          <p style="margin:0 0 24px 0;line-height:1.5;color:#1F2937;">
            <strong>If this was you</strong> and you forgot your password, use the link below to reset it:
          </p>
          <p style="margin:0 0 24px 0;text-align:center;">
            <a href="${escapedUrl}"
               style="display:inline-block;padding:12px 24px;background:#14532D;color:#FFFFFF;text-decoration:none;border-radius:8px;font-weight:600;">
              Reset password
            </a>
          </p>
          <p style="margin:0 0 16px 0;line-height:1.5;color:#1F2937;">
            <strong>If this was not you</strong>, your account is still secure — none of those attempts succeeded. We recommend changing your password as a precaution.
          </p>
          <p style="margin:24px 0 0 0;font-size:13px;color:#6B7280;">
            Sign-in attempts from a single network are throttled after 5 failures in 15 minutes, so brute-force attacks against your account are blocked automatically.
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
    'MoneyMind: Unusual sign-in activity',
    '',
    `We've seen ${failed_count} failed sign-in attempts for ${user_email} in the last ${window_minutes} minutes.`,
    '',
    'If this was you and you forgot your password, reset it here:',
    forgot_password_url,
    '',
    'If this was not you, your account is still secure — none of those attempts succeeded. We recommend changing your password as a precaution.',
    '',
    'Sign-in attempts from a single network are throttled after 5 failures in 15 minutes, so brute-force attacks against your account are blocked automatically.',
    '',
    '— MoneyMind',
    `MoneyMind is a personal project — please don't reply to this email.`,
  ].join('\n');

  return { subject, html, text };
}

module.exports = { build };
