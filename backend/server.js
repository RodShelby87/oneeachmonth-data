const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const cron       = require('node-cron');
const { Octokit } = require('@octokit/rest');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

mongoose.connect(process.env.MONGODB_URI);

// ── Schemas ──────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username:  { type: String, unique: true, required: true },
  email:     { type: String, unique: true, required: true },
  password:  { type: String, required: true },
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
  createdAt: { type: Date, default: Date.now }
});

const User       = mongoose.model('User',       userSchema);
const Submission = mongoose.model('Submission', submissionSchema);
const Comment    = mongoose.model('Comment',    commentSchema);

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

// ── Email helpers ─────────────────────────────────────────────────────
// ── Email via Resend HTTP API ─────────────────────────────────────────
// Plain HTTPS on port 443 — no SMTP, no blocked ports.
async function resendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');
  const from = process.env.RESEND_FROM || 'OneEachMonth <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ from, to, subject, html }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

// "2026-07" → "July 2026"
function formatMonth(m) {
  const [y, mo] = m.split('-');
  return new Date(+y, +mo - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
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

// Send a reminder to ONE specific user for ONE specific month.
async function sendSingleReminder(user, month) {
  const appUrl = process.env.APP_URL || 'https://oneeachmonth.onrender.com';
  await resendEmail({
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
  if (!process.env.RESEND_API_KEY) {
    console.log('RESEND_API_KEY not set — skipping reminders.');
    return { sent: 0, skipped: 0, errors: 0 };
  }

  const appUrl = process.env.APP_URL || 'https://oneeachmonth.onrender.com';
  const query  = calledByMonth ? { expression: '', month: calledByMonth } : { expression: '' };

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
      await resendEmail({
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

// ── Auth ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email) return res.status(400).json({ error: 'Username and email required' });
    const hashed = await bcrypt.hash(password || 'oem-default', 10);
    const user = await User.create({ username, email, password: hashed });
    const month = new Date().toISOString().slice(0, 7);
    await Submission.create({ userId: user._id, username, month });
    res.json({ _id: user._id, username: user.username, email: user.email });
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
    res.json({ _id: user._id, username: user.username, email: user.email, createdAt: user.createdAt });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

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
    const subs = await Submission.find().sort({ month: -1, username: 1 });
    res.json(subs);
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

app.delete('/api/submissions/:id', async (req, res) => {
  try {
    await Submission.findByIdAndDelete(req.params.id);
    await Comment.deleteMany({ subId: req.params.id });
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
    res.json(comment);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Test email (debug only) ───────────────────────────────────────────
// GET /api/test-email  → sends a test email to yourself and returns any error
app.get('/api/test-email', async (req, res) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'RESEND_API_KEY not set' });
  try {
    const data = await resendEmail({
      to:      process.env.GMAIL_USER || 'delivered@resend.dev',
      subject: 'OneEachMonth — email test ✓',
      html:    '<p>If you got this, Resend is working correctly.</p>',
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
      if (!user) return res.status(404).json({ error: 'User not found' });

      // Verify there really is a pending slot for this month
      const slot = await Submission.findOne({ userId: user._id, month: targetMonth, expression: '' });
      if (!slot) return res.status(400).json({ error: 'No pending submission found for that user/month' });

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
