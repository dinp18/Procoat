const TELEGRAM_TOKEN = '8323875930:AAEDbvUAW3YryEob4cZqVU3jQOuEgxvT1g8';
const ANTHROPIC_KEY = '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';
const TELEGRAM_API = 'https://api.telegram.org/bot' + TELEGRAM_TOKEN;

// Conversation history per chat (in-memory, resets on worker restart)
const conversations = {};

async function sendMessage(chatId, text) {
  await fetch(TELEGRAM_API + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    })
  });
}

async function getAllJobs(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT data FROM jobs ORDER BY updated_at DESC'
    ).all();
    return results.map(r => {
      try { return typeof r.data === 'string' ? JSON.parse(r.data) : r.data; }
      catch(e) { return null; }
    }).filter(Boolean);
  } catch(e) {
    return [];
  }
}

async function saveJob(env, job) {
  job.updated_at = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO jobs (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at'
  ).bind(String(job.id), JSON.stringify(job), job.updated_at).run();
}

async function handleMessage(env, chatId, userText) {
  // Get all jobs for context
  const jobs = await getAllJobs(env);

  // Build jobs summary for Claude
  const jobsSummary = jobs.map(j => {
    const sub = (j.quote?.items||[]).reduce((a,i)=>a+i.a,0);
    const total = Math.round((sub + sub*0.1)*100)/100;
    return `Job ID: ${j.id} | Name: ${j.name} | Client: ${j.client} | Phone: ${j.phone||'—'} | Type: ${j.type} | Status: ${j.status} | Start date: ${j.start_date||'not set'} | Quote total: $${total} AUD inc GST | Notes: ${(j.notes||[]).map(n=>n.text).join('; ')||'none'}`;
  }).join('\n');

  const today = new Date().toISOString().split('T')[0];

  const system = `You are the Pro Coat Painting job assistant for Paul Di Natale, a professional painting and restoration business in NSW Australia.

Today's date: ${today}

CURRENT JOBS IN DATABASE:
${jobsSummary || 'No jobs yet.'}

You help Paul manage his painting jobs via Telegram. You can:
1. CREATE new jobs - when Paul describes a new job
2. UPDATE existing jobs - change status, add notes, set start dates, update quotes
3. QUERY jobs - answer questions about what's on, who to call, outstanding quotes etc

When Paul asks you to make a change, respond with the action in JSON at the END of your message like this:
ACTION:{"action":"create_job","job":{"name":"Client Name — Suburb","client":"Full Name","phone":"04xx","address":"address","type":"Exterior repaint","status":"quoted","start_date":"2026-04-07","notes":[],"photos":[],"quote":{"items":[{"d":"Description","a":1000}]},"files":[]}}

Or to update:
ACTION:{"action":"update_job","id":"JOB_ID","changes":{"status":"active","start_date":"2026-04-07"}}

Or to add a note:
ACTION:{"action":"add_note","id":"JOB_ID","note":"Your note text here"}

Or just answer questions with no ACTION block.

Use Australian brands (Dulux, Cabot's, Feast Watson, Haymes). Currency AUD. Be concise and practical — Paul is usually on site.`;

  // Maintain conversation history (last 10 messages)
  if (!conversations[chatId]) conversations[chatId] = [];
  conversations[chatId].push({ role: 'user', content: userText });
  if (conversations[chatId].length > 10) conversations[chatId] = conversations[chatId].slice(-10);

  // Call Claude
  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: system,
      messages: conversations[chatId]
    })
  });

  const aiData = await aiRes.json();
  const reply = aiData.content?.[0]?.text || 'Sorry, I had trouble processing that.';

  // Add assistant reply to history
  conversations[chatId].push({ role: 'assistant', content: reply });

  // Check for ACTION block
  const actionMatch = reply.match(/ACTION:(\{[\s\S]*\})\s*$/);
  let userReply = reply.replace(/ACTION:\{[\s\S]*\}\s*$/, '').trim();

  if (actionMatch) {
    try {
      const action = JSON.parse(actionMatch[1]);

      if (action.action === 'create_job') {
        const newJob = action.job;
        newJob.id = String(Date.now());
        newJob.date = today;
        newJob.notes = newJob.notes || [];
        newJob.photos = [];
        newJob.files = [];
        newJob.quote = newJob.quote || { items: [] };
        await saveJob(env, newJob);
        userReply += '\n\n✅ *Job created in Pro Coat app*';

      } else if (action.action === 'update_job') {
        const targetJob = jobs.find(j => String(j.id) === String(action.id));
        if (targetJob) {
          Object.assign(targetJob, action.changes);
          await saveJob(env, targetJob);
          userReply += '\n\n✅ *Job updated in Pro Coat app*';
        }

      } else if (action.action === 'add_note') {
        const targetJob = jobs.find(j => String(j.id) === String(action.id));
        if (targetJob) {
          if (!targetJob.notes) targetJob.notes = [];
          targetJob.notes.unshift({ text: action.note, date: today });
          await saveJob(env, targetJob);
          userReply += '\n\n✅ *Note added in Pro Coat app*';
        }
      }
    } catch(e) {
      console.error('Action parse error:', e.message);
    }
  }

  return userReply;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Pro Coat Telegram Bot running ✓', { status: 200 });
    }

    try {
      const body = await request.json();
      const message = body.message || body.edited_message;
      if (!message) return new Response('ok');

      const chatId = message.chat.id;
      const text = message.text;

      if (!text) {
        await sendMessage(chatId, "Sorry, I can only handle text messages for now.");
        return new Response('ok');
      }

      // Handle /start command
      if (text === '/start') {
        await sendMessage(chatId, `👋 G'day Paul! I'm your Pro Coat job assistant.\n\nI can help you:\n• Create new jobs\n• Add notes to existing jobs\n• Update job status\n• Check what's on this week\n• Look up client details\n\nJust talk to me naturally — e.g. *"Quoted John Smith in Penrith for an exterior repaint, about $3500, starting next Monday"*`);
        return new Response('ok');
      }

      // Show typing indicator
      await fetch(TELEGRAM_API + '/sendChatAction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' })
      });

      const reply = await handleMessage(env, chatId, text);
      await sendMessage(chatId, reply);

    } catch(e) {
      console.error('Bot error:', e.message);
    }

    return new Response('ok');
  }
};
