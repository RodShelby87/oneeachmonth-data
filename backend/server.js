const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const nodemailer = require('nodemailer');
const cron       = require('node-cron');
const { Octokit } = require('@octokit/rest');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

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

// ── Email (Nodemailer via Gmail) ─────────────────────────────────────
function createTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
}

async function sendReminderEmails() {
  const transporter = createTransporter();
  if (!transporter) { console.log('Email not configured — skipping reminders.'); return; }

  // Previous month string e.g. "2026-06"
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    .toISOString().slice(0, 7);

  const appUrl = process.env.APP_URL || 'https://oneeachmonth.onrender.com';

  const users = await User.find();
  let sent = 0;

  for (const user of users) {
    // Check if they have a filled submission for previous month
    const sub = await Submission.findOne({
      userId: user._id,
      month: prevMonth,
      expression: { $ne: '' }
    });
    if (sub) continue; // already submitted — no email needed

    try {
      await transporter.sendMail({
        from: `"OneEachMonth" <${process.env.GMAIL_USER}>`,
        to: user.email,
        subject: `Hey ${user.username}, your expression for last month is missing 👀`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fffbf5;border-radius:12px">
            <h1 style="font-size:1.5rem;margin-bottom:8px;color:#1c1917">
              Your monthly expression is still missing, lazy ass 😤
            </h1>
            <p style="color:#57534e;font-size:1rem;line-height:1.6;margin-bottom:24px">
              You didn't submit anything for <strong>${prevMonth}</strong>.<br>
              It only takes a minute — go find something good!
            </p>
            <a href="${appUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-weight:700;font-size:1rem;padding:14px 28px;border-radius:8px;text-decoration:none">
              Submit it here →
            </a>
            <p style="color:#a8a29e;font-size:0.8rem;margin-top:32px">
              — OneEachMonth
            </p>
          </div>
        `
      });
      sent++;
      console.log(`Reminder sent to ${user.email}`);
    } catch(err) {
      console.error(`Failed to send to ${user.email}:`, err.message);
    }
  }
  console.log(`Monthly reminders done. Sent: ${sent}/${users.length}`);
}

// ── Cron: 1st of every month at 9:00am UTC ──────────────────────────
cron.schedule('0 9 1 * *', () => {
  console.log('Running monthly reminder cron...');
  sendReminderEmails();
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
    res.json({ _id: user._id, username: user.username, email: user.email });
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

// ── Manual trigger (for testing) ─────────────────────────────────────
app.post('/api/send-reminders', async (req, res) => {
  try { await sendReminderEmails(); res.json({ ok: true }); }
  catch(err) { res.status(500).json({ error: err.message }); }
});

app.listen(process.env.PORT || 3001, () =>
  console.log('OneEachMonth backend running on port', process.env.PORT || 3001)
);
