const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
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
  example:     { type: String, default: '' },      // user-written example
  link:        { type: String, default: '' },      // optional source link
  userComment: { type: String, default: '' },      // submitter's comment
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
      // Edit existing submission by ID
      sub = await Submission.findByIdAndUpdate(
        editId,
        { expression, definition, example, link, userComment, submittedAt: new Date() },
        { new: true }
      );
    } else {
      // Create new or update existing slot for this user+month
      sub = await Submission.findOneAndUpdate(
        { userId, month: targetMonth, expression: '' },  // find empty slot or create
        { expression, definition, example, link, userComment, submittedAt: new Date(), username },
        { upsert: true, new: true }
      );
      // If no empty slot found, create a brand new one (multiple submissions per month)
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
      if (!existing) {
        await Submission.create({ userId: user._id, username: user.username, month, expression: '' });
      }
    }
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

app.listen(process.env.PORT || 3001, () =>
  console.log('OneEachMonth backend running on port', process.env.PORT || 3001)
);
