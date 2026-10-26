import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../config/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { runCareerAssistantAgent } from '../services/careerAssistantAgent.js';

const router = express.Router();

// Chat with AI Career Companion (M3.4 Multi-Agent Orchestration)
router.post('/chat', authenticateToken, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty.' });
    }

    // 1. Fetch student context
    const user = await db.get('SELECT full_name, email FROM users WHERE id = ?', [req.user.id]);
    const profile = await db.get('SELECT * FROM profiles WHERE user_id = ?', [req.user.id]);
    const latestResume = await db.get('SELECT * FROM resumes WHERE user_id = ? ORDER BY uploaded_at DESC LIMIT 1', [req.user.id]);
    const savedJobs = await db.all(
      `SELECT i.title, i.company FROM saved_internships s JOIN internships i ON s.internship_id = i.id WHERE s.user_id = ?`,
      [req.user.id]
    );
    const avgScoreRow = await db.get(
      "SELECT AVG(overall_score) as avgScore FROM interview_sessions WHERE user_id = ? AND status = 'completed'",
      [req.user.id]
    );

    const canonicalSkillMap = {
      'javascript': 'JavaScript', 'js': 'JavaScript', 'typescript': 'TypeScript', 'ts': 'TypeScript',
      'python': 'Python', 'java': 'Java', 'c': 'C', 'c++': 'C++', 'cpp': 'C++', 'c#': 'C#',
      'go': 'Go', 'golang': 'Go', 'html': 'HTML', 'html5': 'HTML', 'css': 'CSS', 'css3': 'CSS',
      'tailwind': 'Tailwind CSS', 'tailwind css': 'Tailwind CSS', 'react': 'React', 'react.js': 'React',
      'reactjs': 'React', 'next.js': 'Next.js', 'nextjs': 'Next.js', 'node.js': 'Node.js', 'nodejs': 'Node.js',
      'express': 'Express.js', 'express.js': 'Express.js', 'fastapi': 'FastAPI', 'flask': 'Flask',
      'rest api': 'REST APIs', 'rest apis': 'REST APIs', 'sql': 'SQL', 'postgresql': 'PostgreSQL',
      'postgres': 'PostgreSQL', 'sqlite': 'SQLite', 'mongodb': 'MongoDB', 'git': 'Git', 'github': 'GitHub',
      'vscode': 'VS Code', 'vs code': 'VS Code', 'docker': 'Docker', 'kubernetes': 'Kubernetes',
      'aws': 'AWS', 'gcp': 'Google Cloud', 'azure': 'Azure', 'machine learning': 'Machine Learning',
      'generative ai': 'Generative AI', 'llms': 'LLMs', 'rag': 'RAG', 'multi-agent systems': 'Multi-Agent Systems',
      'prompt engineering': 'Prompt Engineering', 'google gemini api': 'Google Gemini API',
      'semantic search': 'Semantic Search', 'computer vision': 'Computer Vision', 'opencv': 'OpenCV',
      'scipy': 'SciPy', 'data analytics': 'Data Analytics', 'data science': 'Data Science',
      'data visualization': 'Data Visualization', 'postman': 'Postman', 'figma': 'Figma',
      'agile': 'Agile Development', 'agile development': 'Agile Development', 'supabase': 'Supabase',
      'vercel': 'Vercel', 'render': 'Render'
    };

    let rawSkills = [];
    if (profile && profile.technical_skills) {
      try { rawSkills.push(...(JSON.parse(profile.technical_skills) || [])); } catch {}
    }
    if (latestResume && latestResume.detected_skills_json) {
      try {
        const resumeSkills = JSON.parse(latestResume.detected_skills_json);
        rawSkills.push(
          ...(resumeSkills.programming || []),
          ...(resumeSkills.web || []),
          ...(resumeSkills.aiData || []),
          ...(resumeSkills.cloud || []),
          ...(resumeSkills.tools || [])
        );
      } catch {}
    }

    const seenSkills = new Set();
    const studentSkills = [];
    for (const s of rawSkills) {
      if (!s || typeof s !== 'string') continue;
      const trimmed = s.trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      const canonical = canonicalSkillMap[lower] || (trimmed.charAt(0).toUpperCase() + trimmed.slice(1));
      const key = canonical.toLowerCase();
      if (!seenSkills.has(key)) {
        seenSkills.add(key);
        studentSkills.push(canonical);
      }
    }

    const studentRoles = profile?.preferred_roles ? (typeof profile.preferred_roles === 'string' ? JSON.parse(profile.preferred_roles) : profile.preferred_roles) : [];

    const studentContext = {
      name: user?.full_name || req.user.full_name || 'Student',
      email: user?.email || req.user.email || '',
      phone: profile?.phone || '',
      degree: profile?.degree || '',
      university: profile?.university || '',
      graduation_year: profile?.graduation_year || '',
      location: profile?.location || '',
      preferred_location: profile?.preferred_location || '',
      skills: studentSkills,
      technical_skills: studentSkills,
      soft_skills: profile?.soft_skills ? (typeof profile.soft_skills === 'string' ? JSON.parse(profile.soft_skills) : profile.soft_skills) : [],
      preferred_roles: studentRoles,
      projects: profile?.projects_json ? (typeof profile.projects_json === 'string' ? JSON.parse(profile.projects_json) : profile.projects_json) : [],
      experience: profile?.experience_json ? (typeof profile.experience_json === 'string' ? JSON.parse(profile.experience_json) : profile.experience_json) : [],
      certifications: profile?.certifications_json ? (typeof profile.certifications_json === 'string' ? JSON.parse(profile.certifications_json) : profile.certifications_json) : [],
      hasResume: !!latestResume,
      avgScore: avgScoreRow?.avgScore ? Math.round(avgScoreRow.avgScore) : null,
      savedInternships: savedJobs.map(j => `${j.title} at ${j.company}`)
    };

    // 2. Fetch recent chat history
    const history = await db.all(
      'SELECT role, content FROM chat_messages WHERE user_id = ? ORDER BY timestamp ASC LIMIT 10',
      [req.user.id]
    );

    // 3. Save user's message
    const userMsgId = uuidv4();
    await db.run(
      'INSERT INTO chat_messages (id, user_id, role, content) VALUES (?, ?, ?, ?)',
      [userMsgId, req.user.id, 'user', message.trim()]
    );

    // 4. Generate AI response with Multi-Agent Orchestrator
    const replyText = await runCareerAssistantAgent(message.trim(), studentContext, history);

    // 5. Save assistant reply
    const botMsgId = uuidv4();
    await db.run(
      'INSERT INTO chat_messages (id, user_id, role, content) VALUES (?, ?, ?, ?)',
      [botMsgId, req.user.id, 'assistant', replyText]
    );

    return res.json({
      reply: replyText,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Assistant chat error:', err);
    return res.status(500).json({ error: 'Failed to process AI chat message.' });
  }
});

// Get conversation history
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const history = await db.all(
      'SELECT id, role, content, timestamp FROM chat_messages WHERE user_id = ? ORDER BY timestamp ASC LIMIT 50',
      [req.user.id]
    );
    return res.json({ history });
  } catch (err) {
    console.error('Get chat history error:', err);
    return res.status(500).json({ error: 'Failed to retrieve chat history.' });
  }
});

// Clear conversation history
router.delete('/history', authenticateToken, async (req, res) => {
  try {
    await db.run('DELETE FROM chat_messages WHERE user_id = ?', [req.user.id]);
    return res.json({ message: 'Conversation history reset.' });
  } catch (err) {
    console.error('Clear chat history error:', err);
    return res.status(500).json({ error: 'Failed to clear chat history.' });
  }
});

export default router;
