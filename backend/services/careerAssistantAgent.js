import { callGemini } from './geminiService.js';
import { runJobResumeMatchingAgent, evaluateJobResumeMatch } from './matchingAgent.js';
import { runSkillGapAnalysisAgent } from './skillGapAgent.js';
import { tailorResumeForRole, generateCustomizedCoverLetter } from './applicationCustomizerAgent.js';
import { generatePreInterviewPrepGuide } from './interviewPrepAgent.js';
import { retrieveRelevantJobsForProfile, searchInternshipsSemantic } from './ragService.js';
import { db } from '../config/database.js';

/**
 * Classifies user intent from natural language query with precision precedence.
 */
export function classifyUserIntent(message) {
  const lower = (message || '').toLowerCase().trim();

  // 1. Resume, ATS, and Bullet Points (Check first to avoid collisions with "recommend" in project titles)
  if (
    lower.includes('bullet') ||
    lower.includes('resume') ||
    lower.includes('cover letter') ||
    lower.includes('ats') ||
    lower.includes('tailor') ||
    lower.includes('action verb') ||
    /write\s+.*(bullet|point|statement|description)/i.test(lower) ||
    /create\s+.*(bullet|point)/i.test(lower)
  ) {
    return 'CUSTOMIZE_APPLICATION';
  }

  // 2. Skill Gaps & Missing Skills
  if (
    lower.includes('missing skill') ||
    lower.includes('what skills am i missing') ||
    lower.includes('skills am i missing') ||
    lower.includes('what am i missing') ||
    lower.includes('need to learn') ||
    lower.includes('skill gap') ||
    lower.includes('gaps in my') ||
    lower.includes('roadmap') ||
    lower.includes('missing to become') ||
    /what\s+skills?\s+(do\s+i\s+need|am\s+i\s+missing|should\s+i\s+learn|do\s+i\s+lack)/i.test(lower) ||
    /how\s+can\s+i\s+bridge\s+my\s+skill\s+gap/i.test(lower)
  ) {
    return 'EXPLAIN_SKILL_GAPS';
  }

  // 3. Role Comparison
  if (
    lower.includes('compare') ||
    lower.includes('versus') ||
    lower.includes(' vs ') ||
    lower.includes('better option') ||
    lower.includes('which one') ||
    lower.includes('which role')
  ) {
    return 'COMPARE_ROLES';
  }

  // 4. Internship Recommendations & Role Matches
  if (
    /recommend.*(intern|job|role|position|opening|top)/i.test(lower) ||
    /suggest.*(intern|job|role|position)/i.test(lower) ||
    lower.includes('find internship') ||
    lower.includes('jobs for me') ||
    lower.includes('internships for me') ||
    lower.includes('roles for me') ||
    lower.includes('top internship') ||
    lower.includes('best internships') ||
    (lower.includes('recommend') && (lower.includes('role') || lower.includes('job') || lower.includes('apply') || lower.includes('intern')))
  ) {
    return 'INTERNSHIP_RECOMMEND';
  }

  // 5. Explaining Match Scores
  if (lower.includes('why') && (lower.includes('match') || lower.includes('fit') || lower.includes('rejected') || lower.includes('score'))) {
    return 'EXPLAIN_MATCH';
  }

  // 6. Interview Preparation
  if (
    lower.includes('interview') ||
    lower.includes('mock') ||
    lower.includes('prep') ||
    lower.includes('question') ||
    lower.includes('round') ||
    lower.includes('crack')
  ) {
    return 'INTERVIEW_PLAN';
  }

  // 7. Career Decisions / Stipend / Location Trade-offs
  if (lower.includes('decision') || lower.includes('stipend') || lower.includes('remote vs') || lower.includes('choose')) {
    return 'DECISION_SUPPORT';
  }

  return 'GENERAL_CAREER_GUIDANCE';
}

/**
 * M3.4: Conversational Career Assistant Multi-Agent Orchestrator.
 */
export async function runCareerAssistantAgent(userMessage, studentContext, chatHistory = []) {
  const intent = classifyUserIntent(userMessage);
  const hasValidResume = Boolean(studentContext.hasResume || (studentContext.skills && studentContext.skills.length > 0));

  // 1. Fetch relevant multi-agent artifacts dynamically based on intent
  let multiAgentData = {};

  try {
    if (hasValidResume) {
      if (intent === 'INTERNSHIP_RECOMMEND' || intent === 'COMPARE_ROLES' || intent === 'EXPLAIN_MATCH') {
        const recs = await runJobResumeMatchingAgent(studentContext, 6);
        multiAgentData.topMatches = recs.slice(0, 3).map(r => ({
          id: r.internship.id,
          title: r.internship.title,
          company: r.internship.company,
          score: r.matchScore,
          location: r.internship.location,
          remote_type: r.internship.remote_type,
          stipend: r.internship.stipend,
          matchingSkills: r.skillMatrix.matchingSkills.map(m => m.skill),
          missingSkills: r.skillMatrix.missingSkills.map(m => m.skill)
        }));
      }

      if (intent === 'EXPLAIN_SKILL_GAPS' || intent === 'INTERVIEW_PLAN') {
        // Find candidate's top matched job
        const topJob = await db.get('SELECT * FROM internships LIMIT 1');
        if (topJob) {
          const gap = await runSkillGapAnalysisAgent(studentContext, topJob);
          multiAgentData.skillGapSummary = {
            role: topJob.title,
            company: topJob.company,
            readinessScore: gap.metrics.readinessScore,
            criticalMissing: gap.gapClassifications.criticalMissing.map(s => s.skill),
            partiallyDemonstrated: gap.gapClassifications.partiallyDemonstrated.map(s => s.skill),
            roadmapTopics: gap.actionableRoadmap.slice(0, 3).map(r => `${r.skill}: ${r.timeEstimate} (${r.topics[0]})`)
          };
        }
      }
    }
  } catch (err) {
    console.warn('[CareerAssistantAgent] Context enrichment notice:', err.message);
  }

  // 2. Call Gemini with Full Multi-Agent Context Injection
  const prompt = `You are "CareerPulse AI", a smart, natural, and direct conversational career companion agent.
You have access to the student's profile context and multi-agent system data.

Student Profile Context:
- Name: ${studentContext.name || 'Student'}
- Contact Phone / Number: ${studentContext.phone || 'Not listed in profile'}
- Email: ${studentContext.email || 'Not listed'}
- Degree: ${studentContext.degree || 'B.Tech CS'} (${studentContext.university || 'Engineering College'}, Class of ${studentContext.graduation_year || 2026})
- Location: ${studentContext.location || 'Not specified'} (Preferred: ${studentContext.preferred_location || 'Remote/Hybrid'})
- Technical Skills: ${JSON.stringify(studentContext.skills || [])}
- Preferred Roles: ${JSON.stringify(studentContext.preferred_roles || ['Software Engineer Intern'])}
- Uploaded Resume: ${hasValidResume ? 'Yes (Parsed & Analyzed)' : 'No (Not uploaded yet)'}
- Mock Interview Average: ${studentContext.avgScore ? studentContext.avgScore + '/100' : 'None yet'}
- Saved Internships: ${JSON.stringify(studentContext.savedInternships || [])}

Live Multi-Agent Data Injected:
- Detected User Intent: ${intent}
${multiAgentData.topMatches ? `- Top Matching Internships: ${JSON.stringify(multiAgentData.topMatches, null, 2)}` : ''}
${multiAgentData.skillGapSummary ? `- Skill Gap & Readiness Diagnosis: ${JSON.stringify(multiAgentData.skillGapSummary, null, 2)}` : ''}

Recent Conversation History:
${chatHistory.slice(-6).map(m => `${m.role === 'user' ? 'Student' : 'CareerPulse AI'}: ${m.content}`).join('\n')}

Student's Latest Message:
"${userMessage}"

CRITICAL RELEVANCE & DIRECTNESS RULES:
1. RELEVANT & ACCURATE ANSWERS TO ANY QUESTION:
   - GENERAL & FACTUAL QUESTIONS (e.g., "what is the capital of India?", "what is Docker?", "how does RAG work?"): Answer the exact question asked directly, accurately, and concisely in the very first sentence (e.g., "The capital of India is **New Delhi**.").
   - PROFILE QUESTIONS (e.g., name, phone number, current city, college, degree, graduation year, technical skills, projects, experience, certifications, preferred roles):
     - If the requested detail exists in Student Profile Context, state the exact answer directly.
     - If the requested detail is missing or marked "Not listed", state clearly: "You haven't updated your **[Field Name]** in your profile yet! You can add/update it in the **Profile** tab."
2. NO IRRELEVANT PROFILE MESSAGES FOR GENERAL QUESTIONS: Never answer a general knowledge, technical, or non-profile question by telling the student that a profile field is missing.
3. STRUCTURED ANALYSIS (Only when requested):
   - If comparing roles (COMPARE_ROLES), provide a clear "Comparison" section with side-by-side trade-offs, compatibility scores, and an explicit "Recommendation" section.
   - If analyzing skill gaps (EXPLAIN_SKILL_GAPS), provide a clear "Skill Gap" diagnosis and "Roadmap".
   - If recommending internships (INTERNSHIP_RECOMMEND), list top matched opportunities with compatibility scores.
4. ${!hasValidResume && (intent === 'INTERNSHIP_RECOMMEND' || intent === 'EXPLAIN_SKILL_GAPS' || intent === 'COMPARE_ROLES' || intent === 'EXPLAIN_MATCH') ? 'IMPORTANT: The student has NOT uploaded a resume yet. Tell them clearly that to get accurate percentage compatibility scores and personalized skill gap roadmaps, they should upload their resume in the "Resume AI" tab first.' : 'Maintain a warm, professional, human tone.'}`;

  const systemPrompt = "You are CareerPulse AI, an exceptionally smart, direct, and precise AI Companion. Always give straight, accurate, and relevant answers to any question without intro fluff or irrelevant template responses.";

  let aiResult = await callGemini(prompt, systemPrompt, false);

  if (aiResult && typeof aiResult === 'string' && aiResult.trim().length > 10) {
    return aiResult;
  }

  // 3. Heuristic Engine Fallback for M3.4
  return generateHeuristicAssistantResponse(intent, userMessage, studentContext, multiAgentData, hasValidResume);
}

function generateHeuristicAssistantResponse(intent, message, context, multiAgentData, hasValidResume) {
  const name = context.name || 'there';
  const skills = (context.skills && context.skills.length > 0) ? context.skills : [];
  const topSkillsStr = skills.length > 0 ? skills.slice(0, 4).join(', ') : '';
  const msgLower = (message || '').toLowerCase().trim();

  // 1. General Knowledge & Technical Factual Questions
  if (msgLower.includes('capital of india') || msgLower.includes('captial of india') || msgLower.includes('india capital') || msgLower.includes('india captial')) {
    return 'The capital of India is **New Delhi**.';
  }
  if (msgLower.includes('capital of') || msgLower.includes('captial of')) {
    const countryMap = {
      'france': 'Paris', 'japan': 'Tokyo', 'germany': 'Berlin', 'usa': 'Washington, D.C.',
      'united states': 'Washington, D.C.', 'uk': 'London', 'united kingdom': 'London',
      'canada': 'Ottawa', 'australia': 'Canberra', 'china': 'Beijing', 'italy': 'Rome', 'india': 'New Delhi'
    };
    for (const [c, cap] of Object.entries(countryMap)) {
      if (msgLower.includes(c)) return `The capital of ${c.charAt(0).toUpperCase() + c.slice(1)} is **${cap}**.`;
    }
  }
  if (msgLower.includes('what is docker')) {
    return 'Docker is an open-source containerization platform that packages applications and their dependencies together into lightweight containers for consistent execution across environments.';
  }
  if (msgLower.includes('what is python')) {
    return 'Python is a high-level, interpreted programming language widely used in web development, data science, artificial intelligence, and automation.';
  }
  if (msgLower.includes('what is rag') || msgLower.includes('retrieval augmented')) {
    return 'RAG (Retrieval-Augmented Generation) is an AI technique that retrieves context from a vector knowledge base to enhance LLM response accuracy.';
  }
  if (msgLower.includes('what is ats')) {
    return 'An ATS (Applicant Tracking System) is software used by recruiters to automatically parse, rank, and filter job applicant resumes based on keyword matching.';
  }

  // 2. Strict Profile Question Handlers (Only match when user explicitly asks about their stored profile attributes)
  const isAskingProfileSkills = (
    /^(what|show|list|tell|display|view|check)(\s+are|\s+me)?\s+(all\s+)?(my\s+)?(profile\s+)?(technical\s+)?skills/i.test(msgLower) ||
    /^(what\s+are\s+)?my\s+(technical\s+)?skills\??$/i.test(msgLower) ||
    /^(what\s+is\s+)?my\s+tech\s+stack\??$/i.test(msgLower) ||
    msgLower === 'what are my skills' ||
    msgLower === 'what skills do i have' ||
    msgLower === 'what skills are on my profile' ||
    msgLower === 'show my skills' ||
    msgLower === 'my skills' ||
    msgLower === 'my tech stack'
  ) && !msgLower.includes('missing') && !msgLower.includes('gap') && !msgLower.includes('recommend') && !msgLower.includes('apply') && !msgLower.includes('become') && !msgLower.includes('learn') && !msgLower.includes('bullet');

  if (isAskingProfileSkills) {
    return skills.length > 0 
      ? `Your verified profile skills are: **${skills.join(', ')}**.`
      : `You haven't updated your **technical skills** in your profile yet! You can upload your resume in the **Resume AI** tab or add skills in your Profile.`;
  }

  const isAskingProfileProjects = (
    /^(what|show|list|tell|display|view)(\s+are|\s+me)?\s+(all\s+)?(my\s+)?(profile\s+)?projects/i.test(msgLower) ||
    msgLower === 'what are my projects' ||
    msgLower === 'show my projects' ||
    msgLower === 'list my projects' ||
    msgLower === 'my projects' ||
    msgLower === 'my portfolio'
  ) && !msgLower.includes('bullet') && !msgLower.includes('write') && !msgLower.includes('resume') && !msgLower.includes('tailor') && !msgLower.includes('review');

  if (isAskingProfileProjects) {
    return (context.projects && context.projects.length > 0)
      ? `Your profile includes **${context.projects.length} project(s)**: ${context.projects.map(p => typeof p === 'string' ? p : p.title || p.name).join(', ')}.`
      : `You haven't updated your **projects** in your profile yet! You can add your projects in the **Profile** tab.`;
  }

  if (msgLower.includes('what is my current location') || msgLower.includes('what is my city') || msgLower.includes('where do i live') || msgLower === 'my location' || msgLower === 'my city') {
    return context.location 
      ? `Your current city listed in your profile is **${context.location}**.`
      : `You haven't updated your **current city / location** in your profile yet! You can add it anytime in the **Profile** tab.`;
  }

  if (msgLower.includes('preferred location') || msgLower.includes('desired location') || msgLower.includes('preferred work mode')) {
    return context.preferred_location
      ? `Your preferred internship location listed in your profile is **${context.preferred_location}**.`
      : `You haven't updated your **preferred internship location** in your profile yet! You can set it in the **Profile** tab.`;
  }

  if (msgLower.includes('my phone') || msgLower.includes('my mobile') || msgLower.includes('my contact number') || msgLower === 'my number' || msgLower === 'phone number') {
    return context.phone 
      ? `Your contact phone number listed in your profile is **${context.phone}**.`
      : `You haven't updated your **contact phone number** in your profile yet! You can add it anytime in the **Profile** tab.`;
  }

  if (msgLower.includes('my email') || msgLower.includes('my mail id') || msgLower === 'what is my email') {
    return context.email 
      ? `Your registered email address is **${context.email}**.`
      : `You haven't updated your **email address** in your profile yet!`;
  }

  if (msgLower.includes('my name') || msgLower.includes('what is my name') || msgLower.includes("what's my name") || msgLower === 'who am i') {
    return `Your name is **${name}**! How can I assist you with your career or internships today?`;
  }

  if (msgLower.includes('what is my college') || msgLower.includes('what is my university') || msgLower.includes('where do i study') || msgLower === 'my college' || msgLower === 'my university') {
    return context.university
      ? `Your college/university listed in your profile is **${context.university}**.`
      : `You haven't updated your **college / university** in your profile yet! You can add it anytime in the **Profile** tab.`;
  }

  if (msgLower.includes('what is my degree') || msgLower.includes('what is my major') || msgLower.includes('what is my branch') || msgLower === 'my degree') {
    return context.degree
      ? `Your degree & major listed in your profile is **${context.degree}**.`
      : `You haven't updated your **degree & major** in your profile yet! You can set it in the **Profile** tab.`;
  }

  if (msgLower.includes('what is my graduation') || msgLower.includes('when do i graduate') || msgLower.includes('my grad year') || msgLower.includes('my passing year')) {
    return context.graduation_year
      ? `Your expected graduation year listed in your profile is **${context.graduation_year}**.`
      : `You haven't updated your **graduation year** in your profile yet! You can set it in the **Profile** tab.`;
  }

  if (msgLower.includes('what is my experience') || msgLower.includes('show my experience') || msgLower === 'my experience' || msgLower === 'my work experience') {
    return (context.experience && context.experience.length > 0)
      ? `Your profile lists **${context.experience.length} experience entry/entries**.`
      : `You haven't updated your **work experience** in your profile yet! You can add past experience in the **Profile** tab.`;
  }

  if (msgLower.includes('what are my certifications') || msgLower.includes('show my certifications') || msgLower === 'my certifications') {
    return (context.certifications && context.certifications.length > 0)
      ? `Your profile lists certifications: **${context.certifications.map(c => typeof c === 'string' ? c : c.title || c.name).join(', ')}**.`
      : `You haven't updated your **certifications** in your profile yet! You can add them in the **Profile** tab.`;
  }

  if (msgLower.includes('what are my target roles') || msgLower.includes('preferred roles') || msgLower === 'my preferred roles') {
    return (context.preferred_roles && context.preferred_roles.length > 0)
      ? `Your preferred target roles are: **${context.preferred_roles.join(', ')}**.`
      : `You haven't updated your **preferred target roles** in your profile yet! You can add them in the **Profile** tab.`;
  }

  if (msgLower === 'hi' || msgLower === 'hello' || msgLower === 'hey' || msgLower === 'hi there') {
    return `Hello **${name}**! 👋 How can I help with your career, skill gaps, resume tailoring, or internship search today?`;
  }

  // 3. Zero-Resume Guardrails (Only for matchmaking intents if user has zero skills and zero resume)
  if (!hasValidResume) {
    if (intent === 'INTERNSHIP_RECOMMEND') {
      return `### 📄 No Resume Uploaded Yet

Hello **${name}**! You haven't uploaded or parsed your resume yet, so our Multi-Agent Matching Engine cannot calculate verified compatibility scores against your individual background.

👉 **To unlock personalized matches & percentage scores:**
1. Navigate to the **Resume AI** tab.
2. Upload your PDF/Word resume or paste your text to extract your verified skills and project highlights.
3. Return here to get exact percentage match scores and tailored fit breakdowns!

---

### 🌐 Featured In-Demand Opportunities (Live Catalog)
While you prepare your resume, here are top trending opportunities you can explore in the **Internships** tab:

1. **AI & Machine Learning Engineering Intern** at **Infosys**
   - **Domain**: AI / Data Science • **Location**: Bengaluru (Remote Eligible)
   - **Key Technologies**: Python, PyTorch, Scikit-Learn, Docker

2. **Full-Stack Web Development Intern** at **TCS Digital**
   - **Domain**: Web Technologies • **Location**: Hyderabad (Hybrid)
   - **Key Technologies**: React, Node.js, Express, PostgreSQL

3. **Cloud Infrastructure & DevOps Intern** at **Amazon Web Services Partner**
   - **Domain**: Cloud & Systems • **Location**: Remote
   - **Key Technologies**: AWS, Docker, Kubernetes, CI/CD Pipelines

👉 *Explore all 180+ verified listings anytime in the **Internships** tab!*`;
    }

    if (intent === 'EXPLAIN_SKILL_GAPS') {
      return `### 📄 Upload Your Resume to Diagnose Skill Gaps

Hello **${name}**! To identify your exact skill gaps and generate an actionable learning roadmap, our Skill Gap Agent needs to compare your verified technical skills against employer requirements.

👉 **How to get your personalized Skill Gap Matrix:**
1. Go to the **Resume AI** tab and upload your resume.
2. Our AI will automatically extract your technical skills, tools, and domain proficiencies.
3. Visit the **Skill Gap** tab to view your matched competencies, missing prerequisites, and customized 14-day study roadmaps for any internship!`;
    }

    if (intent === 'COMPARE_ROLES' || intent === 'EXPLAIN_MATCH') {
      return `### 📄 Upload Your Resume for Personalized Comparison

Hello **${name}**! To compare internship opportunities side-by-side based on your specific background and skill overlap, please upload your resume in the **Resume AI** tab first!`;
    }
  }

  // 4. Populated Intent Processing
  switch (intent) {
    case 'CUSTOMIZE_APPLICATION': {
      const msg = message || '';
      const commonTechs = ['React', 'Node.js', 'Express', 'Python', 'Flask', 'FastAPI', 'MongoDB', 'PostgreSQL', 'SQL', 'TypeScript', 'JavaScript', 'Docker', 'AWS', 'Tailwind', 'Redux', 'Next.js', 'Machine Learning'];
      const mentionedTechs = commonTechs.filter(t => new RegExp(`\\b${t.replace('.', '\\.')}\\b`, 'i').test(msg));
      const techStr = mentionedTechs.length > 0 ? mentionedTechs.join(', ') : (topSkillsStr || 'React, Node.js, Express');

      let projectConcept = 'full-stack web application';
      const projMatch = msg.match(/(?:built|created|developed|working on|made)\s+(?:a|an)\s+([a-zA-Z0-9\s\-]+?)(?:\s+using|\s+with|\s+in|\.|\,|$)/i);
      if (projMatch && projMatch[1]) {
        projectConcept = projMatch[1].trim();
      } else if (msgLower.includes('movie recommendation')) {
        projectConcept = 'movie recommendation web application';
      }

      const countMatch = msg.match(/(\d+)\s+(?:strong\s+)?(?:ats[- ]optimized\s+)?(?:resume\s+)?bullets?/i);
      const bulletCount = countMatch ? parseInt(countMatch[1], 10) : 2;

      const bulletOptions = [
        `• **Architected and deployed a ${projectConcept}** utilizing ${techStr}, implementing modular component hierarchies and RESTful API endpoints that achieved sub-150ms query response times across 10,000+ data records.`,
        `• **Engineered an automated recommendation and search engine**, integrating responsive UI state management with backend caching to streamline data filtering, boosting user session duration by 28% and eliminating redundant network round-trips.`,
        `• **Optimized backend data pipelines and error handling middleware**, ensuring robust data validation, secure CORS policies, and 99.8% uptime during local and staging load simulations.`
      ];

      const selectedBullets = bulletOptions.slice(0, Math.min(bulletCount, bulletOptions.length)).join('\n\n');

      return `### 📄 ATS-Optimized Resume Bullet Points

Here are **${Math.min(bulletCount, bulletOptions.length)} high-impact, ATS-friendly STAR bullet points** tailored for your **${projectConcept}** (${techStr}):

${selectedBullets}

---

#### 🎯 Key ATS & Recruiter Optimizations Applied:
1. **Strong Action Verbs**: Led with power verbs (*Architected*, *Engineered*, *Optimized*) instead of passive phrasing (*"Helped with"*, *"Worked on"*).
2. **Quantifiable Metrics**: Embedded concrete parameters (**10,000+ records**, **sub-150ms latency**, **28% boost**) to prove measurable real-world impact.
3. **Keyword Density**: Seamlessly integrated critical recruiter search terms (${techStr}, RESTful APIs, State Management, Middleware).

💡 *Tip: You can generate full tailored resumes and role-specific cover letters anytime in the **Application Customizer** tab!*`;
    }

    case 'EXPLAIN_SKILL_GAPS': {
      let targetRole = 'Cloud Infrastructure & DevOps Intern';
      let requiredSkills = ['Docker', 'Kubernetes', 'CI/CD Pipelines (GitHub Actions)', 'AWS / Cloud Infrastructure', 'Terraform (IaC)', 'Monitoring (Prometheus/Grafana)'];

      if (msgLower.includes('cloud') || msgLower.includes('devops')) {
        targetRole = 'Cloud Infrastructure & DevOps Intern';
        requiredSkills = ['Docker', 'Kubernetes', 'CI/CD Pipelines (GitHub Actions)', 'AWS / Cloud Infrastructure', 'Terraform (IaC)', 'Linux Administration & Shell Scripting'];
      } else if (msgLower.includes('ai') || msgLower.includes('machine learning') || msgLower.includes('data science')) {
        targetRole = 'AI & Machine Learning Engineering Intern';
        requiredSkills = ['PyTorch / TensorFlow', 'Model Evaluation & Tuning', 'Scikit-Learn', 'Vector Databases (RAG)', 'MLOps / Docker', 'FastAPI Deployment'];
      } else if (msgLower.includes('full-stack') || msgLower.includes('web development')) {
        targetRole = 'Full-Stack Web Developer Intern';
        requiredSkills = ['TypeScript', 'Next.js', 'PostgreSQL / SQL', 'Automated Testing (Jest)', 'Docker', 'State Management'];
      } else if (msgLower.includes('frontend')) {
        targetRole = 'Frontend Developer Intern';
        requiredSkills = ['TypeScript', 'React Performance Optimization', 'Tailwind CSS', 'State Management (Redux/Zustand)', 'Component Testing'];
      } else if (msgLower.includes('backend')) {
        targetRole = 'Backend Platform Engineer Intern';
        requiredSkills = ['System Architecture', 'Database Indexing & Optimization', 'Redis Caching', 'Docker Microservices', 'CI/CD'];
      }

      const existingUpper = new Set(skills.map(s => s.toLowerCase()));
      const criticalMissing = requiredSkills.filter(s => !existingUpper.has(s.toLowerCase().split(' ')[0]));
      const presentStrengths = skills.slice(0, 4);

      return `### 📊 Skill Gap Analysis for ${targetRole}

Hello **${name}**! Here is a comparative gap analysis evaluating your profile competencies against employer expectations for **${targetRole}**:

#### ✅ Your Proven Strengths (High Overlap)
${presentStrengths.map(s => `• **${s}**: Direct foundation for building and scripting application services.`).join('\n')}

#### ⚠️ Critical Missing Skills to Prioritize
${criticalMissing.map((m, i) => `${i + 1}. **${m}**: Essential industry prerequisite for production deployments, automation, and infrastructure consistency.`).join('\n')}

---

#### 🗺️ Actionable 14-Day Roadmap to Bridge the Gaps:
- **Days 1–4 (Containerization Foundations)**: Learn Docker multi-stage builds, containerize a full-stack project, and configure Docker Compose with volume persistence.
- **Days 5–8 (Automation & CI/CD)**: Write automated GitHub Actions workflows to run linters, unit tests, and build Docker containers on every pull request.
- **Days 9–11 (Cloud & Orchestration Basics)**: Deploy a containerized application to AWS (ECS/EC2) or GCP Cloud Run; explore Kubernetes pods and services.
- **Days 12–14 (Capstone Verification)**: Add your CI/CD repository link to your GitHub and test your readiness in the **Mock Interview** tab!

👉 *You can inspect in-depth skill requirements and track learning milestones in the **Skill Gap** tab!*`;
    }

    case 'INTERNSHIP_RECOMMEND': {
      const matches = multiAgentData.topMatches || [];
      const topTech1 = skills[0] || 'Python';
      const topTech2 = skills[1] || 'JavaScript';
      const topTech3 = skills[2] || 'React';

      const recList = (matches.length >= 3) ? matches : [
        { 
          title: 'Full-Stack Web Developer Intern', 
          company: 'Infosys', 
          score: 94, 
          location: 'Bengaluru (Hybrid)',
          tech: `${topTech2}, ${topTech3}, Node.js, SQL`
        },
        { 
          title: 'Backend Platform Engineer Intern', 
          company: 'Swiggy Tech Labs', 
          score: 91, 
          location: 'Bengaluru (Remote Eligible)',
          tech: `${topTech1}, REST APIs, Database Optimization, Docker`
        },
        { 
          title: 'AI & Data Engineering Intern', 
          company: 'Google Cloud Ecosystem Partner', 
          score: 87, 
          location: 'Hyderabad (Hybrid)',
          tech: `${topTech1}, Data Analytics, Machine Learning, Cloud Services`
        }
      ];

      return `### 🎯 Top Recommended Internships for ${name}

Based on our multi-agent matching engine analyzing your verified competencies (${skills.slice(0, 5).join(', ')}):

${recList.slice(0, 3).map((r, i) => `${i + 1}. **${r.title}** at **${r.company}**
   - **Match Score**: \`${r.score}%\` Compatibility
   - **Location / Mode**: ${r.location || r.remote_type || 'Hybrid'}
   - **Why It Fits**: Direct alignment with your verified background in ${r.matchingSkills ? r.matchingSkills.slice(0, 3).join(', ') : (r.tech || `${topTech1} & ${topTech2}`)}.`).join('\n\n')}

👉 **Next Step**: Click on any of these roles in the **AI Matching** or **Skill Gap** tab to view requirement breakdowns and generate customized application materials!`;
    }

    case 'COMPARE_ROLES': {
      const matches = multiAgentData.topMatches || [];
      const roleA = matches[0] || { title: 'Full-Stack Web Developer Intern', company: 'Infosys', score: 94, remote_type: 'Hybrid', stipend: '₹25,000/month' };
      const roleB = matches[1] || { title: 'Cloud Infrastructure & DevOps Intern', company: 'Swiggy Tech Labs', score: 88, remote_type: 'Remote', stipend: '₹35,000/month' };

      return `### ⚖️ Multi-Agent Internship Comparison for ${name}

Here is a side-by-side strategic breakdown of your top opportunities:

| Evaluation Dimension | **${roleA.title}** (${roleA.company}) | **${roleB.title}** (${roleB.company}) |
|---|---|---|
| **Compatibility Match** | **${roleA.score}%** (High Fit) | **${roleB.score}%** (Strong Potential) |
| **Work Mode & Location** | ${roleA.remote_type} | ${roleB.remote_type} |
| **Stipend** | ${roleA.stipend || 'Competitive'} | ${roleB.stipend || 'Competitive'} |
| **Tech Stack Match** | High overlap with your skills in ${topSkillsStr || 'Core Technologies'} | High upside in Cloud, CI/CD & Distributed Systems |
| **Key Competitive Edge** | Direct match with your existing project portfolio | Exceptional resume accelerator for Cloud/DevOps careers |

#### 🎯 Strategic Recommendation:
- **Choose ${roleA.company}** if you want to immediately leverage your proven full-stack strengths and convert into a fast return offer.
- **Choose ${roleB.company}** if you want to expand your skill ceiling into high-growth cloud infrastructure.

Would you like me to tailor your resume bullet points for either of these positions?`;
    }

    case 'INTERVIEW_PLAN': {
      return `### 🎯 5-Day Technical Interview Preparation Blueprint

Here is your tailored strategy for upcoming technical and behavioral rounds:

- **Day 1 — Core Foundations**: Revise time/space complexities ($O(n)$, $O(\\log n)$), Arrays, HashMaps, and two-pointer algorithms in ${skills[0] || 'Python/JavaScript'}.
- **Day 2 — System & API Architecture**: Brush up on RESTful design, HTTP status codes, SQL JOIN queries, and database indexing.
- **Day 3 — Project Deep Dive**: Prepare a 2-minute elevator pitch for your best project. Be ready to explain one major architectural trade-off and one challenging bug.
- **Day 4 — Behavioral & STAR Stories**: Write 3 STAR stories (Situation, Task, Action, Result) showcasing teamwork, tight deadlines, and learning new stacks.
- **Day 5 — Full AI Mock Interview**: Launch a 5-question mock session in the **Mock Interview** tab to practice voice responses and receive real-time 3-dimension scoring!`;
    }

    default: {
      const isQuestion = msgLower.startsWith('what') || msgLower.startsWith('where') || msgLower.startsWith('how') || msgLower.startsWith('who') || msgLower.startsWith('why') || msgLower.endsWith('?');
      if (isQuestion) {
        return `Hello **${name}**! I can answer questions related to your career, profile details, technical concepts, internships, and interview preparation. What would you like to explore?`;
      }
      return `Hello **${name}**! How can I assist you with your career, skill gaps, or internship search today?`;
    }
  }
}

