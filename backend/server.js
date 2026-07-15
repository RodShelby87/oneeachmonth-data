const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Octokit } = require('@octokit/rest');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ── MongoDB connection ──────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI);

// ── Schemas ─────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  email:    { type: String, unique: true, required: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const submissionSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username:   { type: String, required: true },
  month:      { type: String, required: true },
  expression: { type: String, default: '' },
  definition: { type: String, default: '' },
  example:    { type: String, default: '' },
  submittedAt: { type: Date }
});

const User = mongoose.model('User', userSchema);
const Submission = mongoose.model('Submission', submissionSchema);

// ── GitHub sync helper ───────────────────────────────────────────────
async function syncToGitHub(data) {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) return;
  try {
    const [owner, repo] = process.env.GITHUB_REPO.split('/');
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const content = JSON.stringify(data, null, 2);
    const encoded = Buffer.from(content).toString('base64');
    const path = `data/submissions.json`;
    let sha;
    try {
      const existing = await octokit.repos.getContent({ owner, repo, path });
      sha = existing.data.sha;
    } catch (_) {}
    await octokit.repos.createOrUpdateFileContents({
      owner, repo, path,
      message: `OneEachMonth sync ${new Date().toISOString()}`,
      content: encoded,
      ...(sha ? { sha } : {})
    });
  } catch (err) {
    console.error('GitHub sync failed:', err.message);
  }
}

// ── Auth routes ──────────────────────────────────────────────────────

// Register (password auto-generated, not needed by user)
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email) return res.status(400).json({ error: 'Username and email required' });
    const hashed = await bcrypt.hash(password || 'oem-default', 10);
    const user = await User.create({ username, email, password: hashed });
    const month = new Date().toISOString().slice(0, 7);
    await Submission.create({ userId: user._id, username, month });
    res.json({ _id: user._id, username: user.username, email: user.email });
  } catch (err) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({ error: `That ${field} is already taken` });
    }
    res.status(500).json({ error: err.message });
  }
});

// Login with username + email only (no password)
app.post('/api/login-no-password', async (req, res) => {
  try {
    const { identifier, email } = req.body;
    if (!identifier || !email) return res.status(400).json({ error: 'Username and email required' });
    const user = await User.findOne({
      $or: [{ username: identifier }, { email: identifier }],
      email: email
    });
    if (!user) return res.status(400).json({ error: 'No account found with that username and email combination' });
    res.json({ _id: user._id, username: user.username, email: user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Submission routes ────────────────────────────────────────────────
app.get('/api/submissions', async (req, res) => {
  try {
    const subs = await Submission.find().sort({ month: -1, username: 1 });
    res.json(subs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/submissions', async (req, res) => {
  try {
    const { userId, username, expression, definition, example } = req.body;
    const month = new Date().toISOString().slice(0, 7);
    const sub = await Submission.findOneAndUpdate(
      { userId, month },
      { expression, definition, example, submittedAt: new Date() },
      { upsert: true, new: true }
    );
    const allSubs = await Submission.find().sort({ month: -1, username: 1 });
    await syncToGitHub(allSubs);
    res.json(sub);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ensure-slots', async (req, res) => {
  try {
    const month = new Date().toISOString().slice(0, 7);
    const users = await User.find();
    for (const user of users) {
      await Submission.findOneAndUpdate(
        { userId: user._id, month },
        { $setOnInsert: { userId: user._id, username: user.username, month, expression: '' } },
        { upsert: true }
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3001, () =>
  console.log('OneEachMonth backend running on port', process.env.PORT || 3001)
);
