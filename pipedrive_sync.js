const express = require('express');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const PIPEDRIVE_API_TOKEN = '010c9ae74d718d6603af7a388fba8a2ae7731ad8';
const INSTUDY_PIPELINE_ID = 15;
const PORT = 3000;

const BASE_URL = 'https://api.pipedrive.com/v1';

const api = axios.create({
  baseURL: BASE_URL,
  params: { api_token: PIPEDRIVE_API_TOKEN }
});

const processedDeals = new Set();

async function getNotes(dealId) {
  const res = await api.get('/notes', { params: { deal_id: dealId, limit: 100 } });
  return res.data.data || [];
}

async function getActivities(dealId) {
  const res = await api.get(`/deals/${dealId}/activities`);
  return res.data.data || [];
}

async function getEmails(dealId) {
  const res = await api.get(`/deals/${dealId}/mailMessages`);
  return res.data.data || [];
}

async function getFiles(dealId) {
  const res = await api.get(`/deals/${dealId}/files`);
  return res.data.data || [];
}

async function findInstudyDeal(originalTitle) {
  const searchTitle = `${originalTitle}-In study`;
  const res = await api.get('/deals/search', {
    params: { term: searchTitle, fields: 'title', exact_match: true, limit: 10 }
  });
  const items = res.data.data?.items || [];
  const match = items.find(i => i.item.pipeline.id === INSTUDY_PIPELINE_ID);
  return match ? match.item : null;
}

async function createNote(dealId, content) {
  await api.post('/notes', { deal_id: dealId, content });
}

async function createActivity(dealId, activity) {
  await api.post('/activities', {
    deal_id: dealId,
    subject: activity.subject || 'Copied activity',
    type: activity.type || 'task',
    due_date: activity.due_date || null,
    note: activity.note || null
  });
}

async function copyFile(file, newDealId) {
  try {
   if (!file.file_name || file.file_name.includes('?s=') || !file.deal_id) return;
console.log('File object:', JSON.stringify(file));
const fileRes = await axios.get(file.remote_url || `https://app.pipedrive.com/api/v1/files/${file.id}/download?api_token=${PIPEDRIVE_API_TOKEN}`, {
  responseType: 'arraybuffer',
  maxRedirects: 10,
  headers: {
    'Authorization': `Bearer ${PIPEDRIVE_API_TOKEN}`
  }
});

    const form = new FormData();
    form.append('file', Buffer.from(fileRes.data), {
      filename: file.file_name,
      contentType: file.file_type || 'application/octet-stream'
    });
    form.append('deal_id', newDealId);

    await axios.post(`${BASE_URL}/files`, form, {
      headers: { ...form.getHeaders() },
      params: { api_token: PIPEDRIVE_API_TOKEN }
    });
  } catch (err) {
    console.error(`Failed to copy file ${file.file_name}:`, err.message);
  }
}

async function processWebhook(event) {
  try {
    if (
      event.meta?.entity !== 'deal' ||
      event.data?.status !== 'won' ||
      event.previous?.status === 'won'
    ) {
      return;
    }

    const deal = event.data;
    const dealId = deal.id;

    if (processedDeals.has(dealId)) {
      console.log(`Already processed deal ${dealId}, skipping`);
      return;
    }
    processedDeals.add(dealId);

    const dealTitle = deal.title;
    console.log(`Processing won deal: ${dealTitle} (ID: ${dealId})`);

    await new Promise(resolve => setTimeout(resolve, 10000));

    const instudyDeal = await findInstudyDeal(dealTitle);
    if (!instudyDeal) {
      console.log(`No Instudy deal found for: ${dealTitle}-In study`);
      return;
    }

    const instudyDealId = instudyDeal.id;
    console.log(`Found Instudy deal: ${instudyDeal.title} (ID: ${instudyDealId})`);

    const notes = await getNotes(dealId);
    console.log(`Copying ${notes.length} notes...`);
    for (const note of notes) {
      await createNote(instudyDealId, note.content);
    }

    const activities = await getActivities(dealId);
    console.log(`Copying ${activities.length} activities...`);
    for (const activity of activities) {
      await createActivity(instudyDealId, activity);
    }

    const emails = await getEmails(dealId);
    console.log(`Copying ${emails.length} emails...`);
    for (const email of emails) {
      console.log('Email object:', JSON.stringify(email));
      await createActivity(instudyDealId, {
        subject: email.subject || 'Email',
        type: 'email',
        note: email.body_text || email.snippet || ''
      });
    }

    const files = await getFiles(dealId);
    console.log(`Copying ${files.length} files...`);
    for (const file of files) {
      await copyFile(file, instudyDealId);
    }

    console.log(`Done syncing deal: ${dealTitle}`);

  } catch (err) {
    console.error('Processing error:', err.message);
  }
}

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  processWebhook(req.body).catch(console.error);
});

app.get('/test', (req, res) => {
  res.send('Server is working!');
});

app.listen(PORT, () => {
  console.log(`Pipedrive sync server running on port ${PORT}`);
});
