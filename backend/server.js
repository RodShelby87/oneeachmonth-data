const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const crypto     = require('crypto');
const cron       = require('node-cron');
const { Octokit } = require('@octokit/rest');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

mongoose.connect(process.env.MONGODB_URI);

// Backend's own public URL — used for admin approve/reject email links
const BACKEND_URL = process.env.BACKEND_URL || 'https://oneeachmonth-data.onrender.com';

// ── Schemas ──────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username:  { type: String, unique: true, required: true },
  email:     { type: String, unique: true, required: true },
  password:  { type: String, required: true },
  // Existing users (created before this field existed) default to 'approved'
  // so this change never locks out anyone already using the site.
  status:    { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved' },
  createdAt: { type: Date, default: Date.now }
});

const submissionSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username:    { type: String, required: true },
  month:       { type: String, required: true },
  expression:  { type: String, default: '' },
  definition:  { type: String, default: '' },
  example:     { type: String, default: '' },
  link:        { type: String, default: '' },
  userComment: { type: String, default: '' },
  submittedAt: { type: Date }
});

const commentSchema = new mongoose.Schema({
  subId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', required: true },
  username:  { type: String, required: true },
  text:      { type: String, required: true },
  parentId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
  createdAt: { type: Date, default: Date.now },
  editedAt:  { type: Date, default: null }
});

const notificationSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:      { type: String, enum: ['submission', 'comment', 'deadline'], required: true },
  message:   { type: String, required: true },
  relatedId: { type: mongoose.Schema.Types.ObjectId, default: null },
  meta:      { type: mongoose.Schema.Types.Mixed, default: {} }, // dedup keys, e.g. { month: '2026-07' }
  createdAt: { type: Date, default: Date.now },
  viewedAt:  { type: Date, default: null }
});

const User         = mongoose.model('User',         userSchema);
const Submission   = mongoose.model('Submission',   submissionSchema);
const Comment      = mongoose.model('Comment',      commentSchema);
const Notification = mongoose.model('Notification', notificationSchema);

// ── GitHub sync ──────────────────────────────────────────────────────
async function syncToGitHub(data) {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) return;
  try {
    const [owner, repo] = process.env.GITHUB_REPO.split('/');
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const encoded = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const path = 'data/submissions.json';
    let sha;
    try { sha = (await octokit.repos.getContent({ owner, repo, path })).data.sha; } catch(_) {}
    await octokit.repos.createOrUpdateFileContents({
      owner, repo, path,
      message: `OneEachMonth sync ${new Date().toISOString()}`,
      content: encoded,
      ...(sha ? { sha } : {})
    });
  } catch(err) { console.error('GitHub sync failed:', err.message); }
}

// ── Email via Gmail API (OAuth2) ──────────────────────────────────────
// Plain HTTPS on port 443, authenticated as the real Gmail account —
// no SMTP, no blocked ports, no third-party sender/DMARC rejection.
let _cachedAccessToken = null;
let _cachedTokenExpiry = 0;

async function getGmailAccessToken() {
  const now = Date.now();
  if (_cachedAccessToken && now < _cachedTokenExpiry - 60000) {
    return _cachedAccessToken; // reuse until ~1 min before expiry
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken  = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN is not set');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Failed to refresh Gmail access token');

  _cachedAccessToken = data.access_token;
  _cachedTokenExpiry = now + (data.expires_in * 1000);
  return _cachedAccessToken;
}

function base64UrlEncode(str) {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendEmail({ to, subject, html }) {
  const accessToken = await getGmailAccessToken();
  const fromEmail = process.env.GMAIL_USER;
  if (!fromEmail) throw new Error('GMAIL_USER is not set');

  // Build a minimal RFC 2822 MIME message
  const messageLines = [
    `From: OneEachMonth <${fromEmail}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
  ].join('\r\n');

  const raw = base64UrlEncode(messageLines);

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));
  return data;
}

// "2026-07" → "July 2026"
function formatMonth(m) {
  const [y, mo] = m.split('-');
  return new Date(+y, +mo - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

// ── Notifications ──────────────────────────────────────────────────────
// Broadcasts a notification to every approved user except the one(s)
// passed in excludeUserIds (e.g. "someone else submitted an expression").
// Accepts a single id or an array of ids to exclude.
async function notifyOtherUsers(excludeUserIds, type, message, relatedId = null) {
  try {
    const excludeArr = (Array.isArray(excludeUserIds) ? excludeUserIds : [excludeUserIds]).filter(Boolean);
    const users = await User.find({ _id: { $nin: excludeArr }, status: 'approved' }).select('_id').lean();
    if (!users.length) return;
    await Notification.insertMany(
      users.map(u => ({ userId: u._id, type, message, relatedId }))
    );
  } catch(err) { console.error('notifyOtherUsers failed:', err.message); }
}

function reminderHtml(username, month, appUrl) {
  const monthLabel = formatMonth(month);
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fffbf5;border-radius:12px">
      <h1 style="font-size:1.5rem;margin-bottom:8px;color:#1c1917">
        Your monthly expression is still missing, lazy ass 😤
      </h1>
      <p style="color:#57534e;font-size:1rem;line-height:1.6;margin-bottom:24px">
        Hey <strong>${username}</strong>, you didn't submit anything for <strong>${monthLabel}</strong>.<br>
        It only takes a minute — go find something good!
      </p>
      <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-weight:700;font-size:1rem;padding:14px 28px;border-radius:8px;text-decoration:none">
        Submit it here →
      </a>
      <p style="color:#a8a29e;font-size:0.8rem;margin-top:32px">— OneEachMonth</p>
    </div>
  `;
}

// ── Admin approval for new signups ────────────────────────────────────
function escapeHtmlServer(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Signed token so the approve/reject links in the email can't be guessed
// or reused for a different user/action.
function approvalToken(userId, action) {
  const secret = process.env.APPROVAL_SECRET || process.env.GOOGLE_CLIENT_SECRET || 'oem-fallback-secret';
  return crypto.createHmac('sha256', secret).update(`${userId}:${action}`).digest('hex').slice(0, 40);
}

function adminApprovalHtml(user, approveUrl, rejectUrl) {
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fffbf5;border-radius:12px">
      <h1 style="font-size:1.4rem;margin-bottom:8px;color:#1c1917">New user wants to join OneEachMonth</h1>
      <p style="color:#57534e;font-size:1rem;line-height:1.6;margin-bottom:24px">
        <strong>${escapeHtmlServer(user.username)}</strong> (${escapeHtmlServer(user.email)}) just signed up and is waiting for your approval.
      </p>
      <table role="presentation" width="100%"><tr>
        <td style="padding-right:8px">
          <a href="${approveUrl}" style="display:block;text-align:center;background:#059669;color:#fff;font-weight:700;font-size:1rem;padding:14px 20px;border-radius:8px;text-decoration:none">✓ Approve</a>
        </td>
        <td style="padding-left:8px">
          <a href="${rejectUrl}" style="display:block;text-align:center;background:#dc2626;color:#fff;font-weight:700;font-size:1rem;padding:14px 20px;border-radius:8px;text-decoration:none">✕ Reject</a>
        </td>
      </tr></table>
      <p style="color:#a8a29e;font-size:0.8rem;margin-top:32px">— OneEachMonth</p>
    </div>
  `;
}

async function sendAdminApprovalEmail(user) {
  const adminEmail = process.env.GMAIL_USER;
  if (!adminEmail) { console.log('GMAIL_USER not set — cannot send admin approval email.'); return; }
  const approveUrl = `${BACKEND_URL}/api/admin/approve-user?id=${user._id}&token=${approvalToken(user._id, 'approve')}`;
  const rejectUrl  = `${BACKEND_URL}/api/admin/reject-user?id=${user._id}&token=${approvalToken(user._id, 'reject')}`;
  await sendEmail({
    to:      adminEmail,
    subject: `New signup: ${user.username} needs approval`,
    html:    adminApprovalHtml(user, approveUrl, rejectUrl),
  });
  console.log(`Admin approval email sent for ${user.username}`);
}

// Renders a plain confirmation page — this is what the admin sees after
// clicking Approve/Reject in the email (a link click, not an API call).
function approvalResultPage(title, msg, color) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title></head>
  <body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;padding:0 20px">
    <h1 style="color:${color}">${title}</h1>
    <p style="color:#57534e;font-size:1rem;line-height:1.6">${msg}</p>
  </body></html>`;
}
async function sendSingleReminder(user, month) {
  const appUrl = process.env.APP_URL || 'https://oneeachmonth.onrender.com';
  await sendEmail({
    to:      user.email,
    subject: `Hey ${user.username}, your expression for ${formatMonth(month)} is missing 👀`,
    html:    reminderHtml(user.username, month, appUrl),
  });
  console.log(`Reminder sent → ${user.email} (${month})`);
  return { ok: true };
}

// Send reminders to ALL users who have ANY pending (empty) submission.
// When calledByMonth is set (cron use), only checks that specific month.
async function sendAllPendingReminders(calledByMonth = null) {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    console.log('GOOGLE_REFRESH_TOKEN not set — skipping reminders.');
    return { sent: 0, skipped: 0, errors: 0 };
  }

  const appUrl = process.env.APP_URL || 'https://oneeachmonth.onrender.com';
  const emptyExpr = { $or: [{ expression: '' }, { expression: null }, { expression: { $exists: false } }] };
  const query  = calledByMonth
    ? { month: calledByMonth, ...emptyExpr }
    : emptyExpr;

  const pendingSlots = await Submission.find(query).lean();
  if (!pendingSlots.length) {
    console.log('No pending submissions — nothing to send.');
    return { sent: 0, skipped: 0, errors: 0 };
  }

  // Group by userId — one email per user listing ALL their missing months
  const byUser = {};
  for (const slot of pendingSlots) {
    const key = String(slot.userId);
    if (!byUser[key]) byUser[key] = { userId: slot.userId, username: slot.username, months: [] };
    byUser[key].months.push(slot.month);
  }

  let sent = 0, skipped = 0, errors = 0;

  for (const entry of Object.values(byUser)) {
    const user = await User.findById(entry.userId).lean();
    if (!user) { skipped++; continue; }

    entry.months.sort();
    const monthLines   = entry.months.map(m => `<li style="margin-bottom:4px">${formatMonth(m)}</li>`).join('');
    const subjectLabel = entry.months.length === 1
      ? formatMonth(entry.months[0])
      : `${entry.months.length} months`;

    try {
      await sendEmail({
        to:      user.email,
        subject: `Hey ${user.username}, you're missing expressions for ${subjectLabel} 👀`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fffbf5;border-radius:12px">
            <h1 style="font-size:1.5rem;margin-bottom:8px;color:#1c1917">Still missing some expressions, lazy ass 😤</h1>
            <p style="color:#57534e;font-size:1rem;line-height:1.6;margin-bottom:16px">
              Hey <strong>${user.username}</strong>, you haven't submitted for:
            </p>
            <ul style="color:#57534e;font-size:1rem;line-height:1.8;margin-bottom:24px;padding-left:20px">
              ${monthLines}
            </ul>
            <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-weight:700;font-size:1rem;padding:14px 28px;border-radius:8px;text-decoration:none">
              Submit now →
            </a>
            <p style="color:#a8a29e;font-size:0.8rem;margin-top:32px">— OneEachMonth</p>
          </div>
        `,
      });
      sent++;
      console.log(`Reminder sent → ${user.email} (${entry.months.join(', ')})`);
    } catch(err) {
      errors++;
      console.error(`Failed to send to ${user.email}:`, err.message);
    }
  }

  console.log(`Reminders done. sent=${sent} skipped=${skipped} errors=${errors}`);
  return { sent, skipped, errors };
}

// ── Cron: 1st of every month at 9:00am UTC ──────────────────────────
// Reminds everyone who didn't submit for the month that just ended.
cron.schedule('0 9 1 * *', async () => {
  console.log('Running monthly reminder cron...');
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    .toISOString().slice(0, 7);
  await sendAllPendingReminders(prevMonth);
});

// ── Cron: daily at 8:00am UTC ─────────────────────────────────────────
// Notifies anyone with a pending submission once the current month has
// 5 or fewer days left. Deduplicated per user+month so it only fires once.
cron.schedule('0 8 * * *', async () => {
  try {
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const remaining = daysInMonth - now.getDate() + 1; // inclusive of today
    if (remaining > 5) return;

    const month = now.toISOString().slice(0, 7);
    const users = await User.find({ status: 'approved' }).lean();

    for (const user of users) {
      const sub = await Submission.findOne({ userId: user._id, month, expression: { $nin: ['', null] } });
      if (sub) continue; // already submitted

      const already = await Notification.findOne({ userId: user._id, type: 'deadline', 'meta.month': month });
      if (already) continue; // already notified this month

      await Notification.create({
        userId:  user._id,
        type:    'deadline',
        message: `Only ${remaining} day${remaining !== 1 ? 's' : ''} left to submit your expression for ${formatMonth(month)}!`,
        meta:    { month }
      });
    }
  } catch(err) { console.error('Deadline notification cron failed:', err.message); }
});

// ── Cron: daily at 8:30am UTC ─────────────────────────────────────────
// Permanently deletes notifications that were viewed more than 30 days ago.
cron.schedule('30 8 * * *', async () => {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await Notification.deleteMany({ viewedAt: { $ne: null, $lt: cutoff } });
    if (result.deletedCount) console.log(`Purged ${result.deletedCount} old notifications.`);
  } catch(err) { console.error('Notification cleanup cron failed:', err.message); }
});

// ── Auth ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email) return res.status(400).json({ error: 'Username and email required' });
    const hashed = await bcrypt.hash(password || 'oem-default', 10);
    const user = await User.create({ username, email, password: hashed, status: 'pending' });
    const month = new Date().toISOString().slice(0, 7);
    await Submission.create({ userId: user._id, username, month });

    // Fire-and-forget — don't block registration if the email fails
    sendAdminApprovalEmail(user).catch(err => console.error('Admin approval email failed:', err.message));

    res.json({
      pending: true,
      message: "Thanks! Your account is waiting for approval — you'll be able to sign in once it's confirmed."
    });
  } catch(err) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ error: `That ${field} is already taken` });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login-no-password', async (req, res) => {
  try {
    const { identifier, email } = req.body;
    if (!identifier || !email) return res.status(400).json({ error: 'Username and email required' });
    const user = await User.findOne({
      $or: [{ username: identifier }, { email: identifier }],
      email: email
    });
    if (!user) return res.status(400).json({ error: 'No account found with that username and email' });
    if (user.status === 'pending')  return res.status(403).json({ error: 'Your account is still awaiting approval.' });
    if (user.status === 'rejected') return res.status(403).json({ error: 'Your registration was not approved.' });
    res.json({ _id: user._id, username: user.username, email: user.email, createdAt: user.createdAt });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Admin approval links (clicked directly from the notification email) ─
async function handleApprovalAction(req, res, newStatus) {
  const { id, token } = req.query;
  const action = newStatus === 'approved' ? 'approve' : 'reject';
  const expected = id ? approvalToken(id, action) : null;

  if (!id || !token || token !== expected) {
    return res.status(403).send(approvalResultPage('Invalid or expired link', 'This approval link is not valid.', '#dc2626'));
  }
  try {
    const user = await User.findById(id);
    if (!user) return res.status(404).send(approvalResultPage('User not found', 'This user no longer exists.', '#dc2626'));

    if (user.status !== 'pending') {
      return res.send(approvalResultPage('Already handled', `${escapeHtmlServer(user.username)} was already marked as <strong>${user.status}</strong>.`, '#57534e'));
    }

    user.status = newStatus;
    await user.save();

    if (newStatus === 'rejected') {
      // Clean up their empty placeholder submission slot
      await Submission.deleteMany({ userId: user._id, expression: '' });
    }

    return res.send(approvalResultPage(
      newStatus === 'approved' ? 'User approved ✓' : 'User rejected',
      `${escapeHtmlServer(user.username)} (${escapeHtmlServer(user.email)}) has been <strong>${newStatus}</strong>.`,
      newStatus === 'approved' ? '#059669' : '#dc2626'
    ));
  } catch(err) {
    return res.status(500).send(approvalResultPage('Error', escapeHtmlServer(err.message), '#dc2626'));
  }
}

app.get('/api/admin/approve-user', (req, res) => handleApprovalAction(req, res, 'approved'));
app.get('/api/admin/reject-user',  (req, res) => handleApprovalAction(req, res, 'rejected'));

// ── User profile: update ─────────────────────────────────────────────
app.put('/api/users/:id', async (req, res) => {
  try {
    const { username, email } = req.body;
    if (!username || !email) return res.status(400).json({ error: 'Username and email required' });
    const existing = await User.findOne({ $or: [{ username }, { email }], _id: { $ne: req.params.id } });
    if (existing) {
      const field = existing.username === username ? 'username' : 'email';
      return res.status(400).json({ error: `That ${field} is already taken` });
    }
    const oldUser = await User.findById(req.params.id);
    if (!oldUser) return res.status(404).json({ error: 'User not found' });
    const user = await User.findByIdAndUpdate(req.params.id, { username, email }, { new: true });
    await Submission.updateMany({ userId: req.params.id }, { username });
    if (oldUser.username !== username) {
      await Comment.updateMany({ username: oldUser.username }, { username });
    }
    res.json({ _id: user._id, username: user.username, email: user.email, createdAt: user.createdAt });
  } catch(err) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ error: `That ${field} is already taken` });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── User profile: delete account ─────────────────────────────────────
app.delete('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const subs = await Submission.find({ userId: req.params.id });
    for (const sub of subs) await Comment.deleteMany({ subId: sub._id });
    await Submission.deleteMany({ userId: req.params.id });
    await Comment.deleteMany({ username: user.username });
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Submissions ──────────────────────────────────────────────────────
app.get('/api/submissions', async (req, res) => {
  try {
    const subs = await Submission.find().sort({ month: -1, username: 1 }).lean();

    // Attach a real comment count to each submission — previously the
    // frontend only knew a submission's comment count after opening its
    // modal, so any card never opened always showed 0.
    const counts = await Comment.aggregate([
      { $group: { _id: '$subId', count: { $sum: 1 } } }
    ]);
    const countMap = {};
    counts.forEach(c => { countMap[String(c._id)] = c.count; });

    const withCounts = subs.map(s => ({ ...s, commentCount: countMap[String(s._id)] || 0 }));
    res.json(withCounts);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/submissions', async (req, res) => {
  try {
    const { userId, username, month, expression, definition, example, link, userComment, editId } = req.body;
    const targetMonth = month || new Date().toISOString().slice(0, 7);
    let sub;
    if (editId) {
      sub = await Submission.findByIdAndUpdate(
        editId,
        { expression, definition, example, link, userComment, submittedAt: new Date() },
        { new: true }
      );
    } else {
      sub = await Submission.findOneAndUpdate(
        { userId, month: targetMonth, expression: '' },
        { expression, definition, example, link, userComment, submittedAt: new Date(), username },
        { upsert: true, new: true }
      );
      if (!sub || !sub.expression) {
        sub = await Submission.create({
          userId, username, month: targetMonth,
          expression, definition, example, link, userComment,
          submittedAt: new Date()
        });
      }
    }
    const allSubs = await Submission.find().sort({ month: -1, username: 1 });
    await syncToGitHub(allSubs);

    // Notify everyone else — but only for brand-new submissions, not edits
    if (!editId && expression) {
      notifyOtherUsers(
        userId,
        'submission',
        `${username} submitted an expression for ${formatMonth(targetMonth)}`,
        sub._id
      );
    }

    res.json(sub);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ensure-slots', async (req, res) => {
  try {
    const month = new Date().toISOString().slice(0, 7);
    const users = await User.find();
    for (const user of users) {
      const existing = await Submission.findOne({ userId: user._id, month });
      if (!existing) await Submission.create({ userId: user._id, username: user.username, month, expression: '' });
    }
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── AI meaning lookup via Merriam-Webster ────────────────────────────
app.post('/api/lookup-meaning', async (req, res) => {
  try {
    const { subId, expression } = req.body;
    if (!expression) return res.status(400).json({ error: 'Missing expression' });
    const key = process.env.MERRIAM_WEBSTER_KEY;
    if (!key) return res.status(500).json({ error: 'API key not configured' });
    const queries = [
      expression.toLowerCase().trim(),
      expression.toLowerCase().replace(/["""'']/g, '').trim(),
      expression.toLowerCase().split(' ').filter(w => w.length > 3)[0]
    ].filter(Boolean);
    let definition = '';
    for (const query of queries) {
      const url = `https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encodeURIComponent(query)}?key=${key}`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const data = await r.json();
      if (!Array.isArray(data) || !data[0]) continue;
      if (typeof data[0] === 'string') continue;
      if (data[0].shortdef && data[0].shortdef.length > 0) { definition = data[0].shortdef[0]; break; }
      const defs = data[0].def;
      if (defs && defs[0] && defs[0].sseq) {
        const sense = defs[0].sseq[0][0][1];
        if (sense && sense.dt && sense.dt[0] && sense.dt[0][0] === 'text') {
          definition = sense.dt[0][1].replace(/\{[^}]+\}/g, '').trim(); break;
        }
      }
    }
    if (!definition) return res.status(404).json({ error: 'No definition found' });
    if (subId) await Submission.findByIdAndUpdate(subId, { definition });
    res.json({ definition });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/submissions/patch-meaning', async (req, res) => {
  try {
    const { subId, definition } = req.body;
    if (!subId || !definition) return res.status(400).json({ error: 'Missing fields' });
    await Submission.findByIdAndUpdate(subId, { definition });
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Meaning lookup — multiple options, used by the pre-save picker ────
// Returns an array of candidate definitions so the user can choose one,
// edit the search term to try again, or decline all of them.
app.post('/api/lookup-meaning-options', async (req, res) => {
  try {
    const { expression } = req.body;
    if (!expression) return res.status(400).json({ error: 'Missing expression' });
    const key = process.env.MERRIAM_WEBSTER_KEY;
    if (!key) return res.status(500).json({ error: 'API key not configured' });

    const queries = [
      expression.toLowerCase().trim(),
      expression.toLowerCase().replace(/["""'']/g, '').trim(),
      expression.toLowerCase().split(' ').filter(w => w.length > 3)[0]
    ].filter(Boolean);

    const options = [];
    const seen = new Set();

    for (const query of queries) {
      const url = `https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encodeURIComponent(query)}?key=${key}`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const data = await r.json();
      if (!Array.isArray(data)) continue;

      for (const entry of data) {
        if (typeof entry === 'string') continue; // spelling suggestion, not a real entry
        if (entry.shortdef && entry.shortdef.length) {
          for (const def of entry.shortdef) {
            const clean = def.trim();
            const key2 = clean.toLowerCase();
            if (clean && !seen.has(key2)) {
              seen.add(key2);
              options.push(clean);
            }
          }
        }
      }
      if (options.length >= 6) break;
    }

    res.json({ options: options.slice(0, 6) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/submissions/:id', async (req, res) => {
  try {
    await Submission.findByIdAndDelete(req.params.id);
    await Comment.deleteMany({ subId: req.params.id });
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Notifications ────────────────────────────────────────────────────
// GET /api/notifications/:userId
//   Returns unviewed notifications plus anything viewed within the last
//   30 days. Older viewed notifications are hidden here and permanently
//   purged by the daily cleanup cron.
app.get('/api/notifications/:userId', async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const notifs = await Notification.find({
      userId: req.params.userId,
      $or: [{ viewedAt: null }, { viewedAt: { $gte: cutoff } }]
    }).sort({ createdAt: -1 }).limit(50);
    res.json(notifs);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/notifications/mark-viewed  { userId }
//   Marks all currently-unviewed notifications for that user as viewed now.
app.post('/api/notifications/mark-viewed', async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    await Notification.updateMany({ userId, viewedAt: null }, { viewedAt: new Date() });
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Comments ─────────────────────────────────────────────────────────
app.get('/api/comments/:subId', async (req, res) => {
  try {
    const c = await Comment.find({ subId: req.params.subId }).sort({ createdAt: 1 });
    res.json(c);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/comments', async (req, res) => {
  try {
    const { subId, text, username, parentId } = req.body;
    if (!subId || !text || !username) return res.status(400).json({ error: 'Missing fields' });
    const comment = await Comment.create({ subId, text, username, parentId: parentId || null });

    try {
      const sub = await Submission.findById(subId).lean();
      if (sub) {
        const commenter = await User.findOne({ username }).select('_id').lean();

        // Notify the submission's owner specifically, unless they're commenting on their own
        if (sub.username !== username) {
          await Notification.create({
            userId:    sub.userId,
            type:      'comment',
            message:   `${username} commented on your submission "${sub.expression}"`,
            relatedId: sub._id
          });
        }

        // Also let everyone else know a comment happened, even on submissions
        // that aren't theirs — excludes the commenter and the owner (who
        // already got the more specific message above).
        await notifyOtherUsers(
          [commenter?._id, sub.userId],
          'comment',
          `${username} commented on ${sub.username}'s submission "${sub.expression}"`,
          sub._id
        );
      }
    } catch(e) { console.error('Comment notification failed:', e.message); }

    res.json(comment);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/comments/:id  { username, text }
//   Edits a comment's text. Only the original author (matched by username)
//   can edit — this app has no auth tokens, so ownership is checked by
//   comparing the requester's username against the comment's stored one.
app.put('/api/comments/:id', async (req, res) => {
  try {
    const { username, text } = req.body;
    if (!username || !text || !text.trim()) return res.status(400).json({ error: 'Missing fields' });

    const comment = await Comment.findById(req.params.id);
    if (!comment) return res.status(404).json({ error: 'Comment not found' });
    if (comment.username !== username) return res.status(403).json({ error: 'You can only edit your own comments' });

    comment.text = text.trim();
    comment.editedAt = new Date();
    await comment.save();

    res.json(comment);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Test email (debug only) ───────────────────────────────────────────
// GET /api/test-email  → sends a test email and returns any error
app.get('/api/test-email', async (req, res) => {
  if (!process.env.GOOGLE_REFRESH_TOKEN) return res.status(500).json({ error: 'GOOGLE_REFRESH_TOKEN not set' });
  try {
    const data = await sendEmail({
      to:      process.env.GMAIL_USER,
      subject: 'OneEachMonth — email test ✓',
      html:    '<p>If you got this, Gmail API is working correctly.</p>',
    });
    res.json({ ok: true, data });
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Reminders ─────────────────────────────────────────────────────────
// POST /api/send-reminders
//   body {}                              → remind all users with ANY pending month
//   body { targetUsername, targetMonth } → remind ONE user for ONE specific month
app.post('/api/send-reminders', async (req, res) => {
  try {
    const { targetUsername, targetMonth } = req.body || {};

    if (targetUsername && targetMonth) {
      // Single targeted reminder
      const user = await User.findOne({ username: targetUsername });
      if (!user) return res.status(404).json({ error: `User "${targetUsername}" not found` });

      // Check for a pending slot — expression is '', null, undefined, or missing
      const slot = await Submission.findOne({
        userId: user._id,
        month: targetMonth,
        $or: [{ expression: '' }, { expression: null }, { expression: { $exists: false } }]
      });
      if (!slot) return res.status(400).json({ error: `No pending submission found for ${targetUsername} in ${targetMonth}` });

      await sendSingleReminder(user, targetMonth);
      return res.json({ ok: true, sent: 1 });
    }

    // Bulk: remind everyone with any pending submission
    const result = await sendAllPendingReminders();
    res.json({ ok: true, ...result });

  } catch(err) {
    console.error('send-reminders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3001, () =>
  console.log('OneEachMonth backend running on port', process.env.PORT || 3001)
);
