// Account-deletion confirmation email. Sent immediately after the
// soft-delete succeeds. Plain language — the user just deleted their
// account, they don't want a wall of legalese.
//
// Template input: { user_email, deleted_at_iso }
//   • user_email     — the email that owned the deleted account
//   • deleted_at_iso — ISO-8601 timestamp of the soft-delete

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function build({ user_email, deleted_at_iso }) {
  const subject = 'Your MoneyMind account has been deleted';
  const escapedEmail = escapeHtml(user_email);
  const escapedTs = escapeHtml(deleted_at_iso);

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F0FDF4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#0B1F14;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F0FDF4;padding:40px 20px;">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border:1px solid #E5E7EB;border-radius:12px;padding:32px;">
        <tr><td>
          <div style="font-weight:700;color:#14532D;font-size:18px;margin-bottom:24px;">◆ MoneyMind</div>
          <h1 style="margin:0 0 16px 0;font-size:22px;color:#0B1F14;">Your account has been deleted</h1>
          <p style="margin:0 0 16px 0;line-height:1.5;color:#1F2937;">
            We've deleted the MoneyMind account for <strong>${escapedEmail}</strong> on
            <strong>${escapedTs}</strong>. Your bank connections have been removed from
            Plaid, so MoneyMind can no longer pull data from those banks.
          </p>
          <p style="margin:0 0 16px 0;line-height:1.5;color:#1F2937;">
            All of your account data — transactions, balances, budgets, findings —
            will be permanently removed from our database within 30 days. After
            that point, the data is unrecoverable.
          </p>
          <p style="margin:0 0 16px 0;line-height:1.5;color:#1F2937;">
            If you didn't mean to delete your account, reply to this email within
            30 days and we can restore it. After 30 days, restoration is no longer
            possible.
          </p>
          <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0;">
          <p style="margin:0;font-size:12px;color:#6B7280;">
            MoneyMind is a personal project — please don't reply to this email
            unless you need to recover your account.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    'Your MoneyMind account has been deleted',
    '',
    `We've deleted the MoneyMind account for ${user_email} on ${deleted_at_iso}.`,
    'Your bank connections have been removed from Plaid, so MoneyMind can no',
    'longer pull data from those banks.',
    '',
    'All of your account data — transactions, balances, budgets, findings —',
    'will be permanently removed from our database within 30 days. After that',
    'point, the data is unrecoverable.',
    '',
    "If you didn't mean to delete your account, reply to this email within 30",
    'days and we can restore it. After 30 days, restoration is no longer possible.',
    '',
    '— MoneyMind',
  ].join('\n');

  return { subject, html, text };
}

module.exports = { build };
