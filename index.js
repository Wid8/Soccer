const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const http = require('http');
const { URL } = require('url');
const stringSimilarity = require('string-similarity');

// ==================== הגדרות ====================
const GROUP_NAME = 'כדורגל ימי ג\' בהוד"ש ⚽';
const PAYBOX_LINK = 'https://links.payboxapp.com/5B58fGzSKUb';
const PAYMENT_AMOUNT = '30';
const DATA_FILE = path.join(__dirname, 'data.json');
const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const SIMILARITY_THRESHOLD = 0.75;

const REGULARS = [
  'אייל קרוואני', 'אסף', 'אורן', 'דורון', 'תומר לבון',
  'דביר', 'אופק', 'זיו', 'גיא', 'מור', 'אבי', 'שגיא',
  'סרגיי', 'רועי', 'טל וידרמן', 'שמעון', 'סהר', 'ג\'רזי',
  'ודים', 'הראל ליסון'
];

// ==================== ניהול נתונים ====================
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return fs.readJsonSync(DATA_FILE);
  } catch (e) {}
  return { pendingPayments: [], active: false, groupId: null };
}

function saveData(data) {
  fs.writeJsonSync(DATA_FILE, data, { spaces: 2 });
}

// ==================== זיהוי חכם ====================
function isSimilarToRegular(name) {
  for (const regular of REGULARS) {
    if (name.includes(regular) || regular.includes(name)) return true;
    if (stringSimilarity.compareTwoStrings(name, regular) >= SIMILARITY_THRESHOLD) return true;
  }
  return false;
}

function isSimilarToPending(sender, pendingList) {
  for (const name of pendingList) {
    if (sender.includes(name) || name.includes(sender)) return name;
    if (stringSimilarity.compareTwoStrings(sender, name) >= SIMILARITY_THRESHOLD) return name;
  }
  return null;
}

function extractNonRegulars(text) {
  return text.split('\n')
    .map(line => { const m = line.match(/^\d+\.\s*(.+)/); return m ? m[1].trim() : null; })
    .filter(Boolean)
    .filter(name => !isSimilarToRegular(name));
}

// ==================== הודעות ====================
const GENERAL_MESSAGE = `⚽ בוט תזכורת תשלום ⚽

מי שהשתתף במשחק הערב ואינו ברשימת הקבועים — נא להעביר ${PAYMENT_AMOUNT} ש״ח לפייבוקס של הקבוצה:
${PAYBOX_LINK}

מי ששילם — שיכתוב "שולם" בקבוצה 🙏`;

function buildReminderMessage(pending) {
  return `⚽ בוט תזכורת תשלום ⚽

המשתתפים הבאים טרם העבירו תשלום עבור המשחק:
${pending.map(n => `• ${n}`).join('\n')}

נא להעביר ${PAYMENT_AMOUNT} ש״ח לפייבוקס:
${PAYBOX_LINK}

מי ששילם — שיכתוב "שולם" בקבוצה 🙏`;
}

// ==================== WhatsApp ====================
let sock = null;
let currentQR = null;
let isConnected = false;
let cronJobsSet = false;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    keepAliveIntervalMs: 30000, // keep-alive כל 30 שניות
    connectTimeoutMs: 60000,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { currentQR = qr; console.log('📱 QR מוכן לסריקה'); }
    if (connection === 'close') {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`🔌 התנתק (קוד: ${code}). מתחבר מחדש: ${!loggedOut}`);
      if (!loggedOut) setTimeout(connectToWhatsApp, 5000);
    } else if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('✅ הבוט מחובר!');
      if (!cronJobsSet) {
        cronJobsSet = true;
        setupCronJobs();
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      const sender = msg.pushName || '';
      const isGroup = msg.key.remoteJid.includes('@g.us');
      const data = loadData();

      // שמירת רשימה שבועית
      if (isGroup && text.includes('קבוצה 1') && text.includes('קבוצה 2')) {
        data.lastWeeklyListText = text;
        data.lastWeeklyListGroupId = msg.key.remoteJid;
        data.lastWeeklyListTime = new Date().toISOString();
        saveData(data);
        console.log('📋 רשימה שבועית נשמרה!');
      }

      // זיהוי "שולם" בקבוצה
      if (isGroup && text === 'שולם' && data.active && data.groupId === msg.key.remoteJid) {
        const matched = isSimilarToPending(sender, data.pendingPayments);
        if (matched) {
          data.pendingPayments = data.pendingPayments.filter(n => n !== matched);
          saveData(data);
          console.log(`✅ ${sender} שילם. נותרו: ${data.pendingPayments.join(', ') || 'אף אחד'}`);
        }
      }
    }
  });
}

// ==================== שליחת הודעות ====================
async function sendToGroup(text) {
  if (!isConnected || !sock) { console.log('❌ לא מחובר'); return false; }
  const data = loadData();
  const groupId = data.groupId || data.lastWeeklyListGroupId;
  if (!groupId) { console.log('❌ לא נמצא ID של קבוצה'); return false; }
  try {
    await sock.sendMessage(groupId, { text });
    console.log('✅ הודעה נשלחה!');
    return true;
  } catch (e) {
    console.log('❌ שגיאה בשליחה:', e.message);
    return false;
  }
}

async function sendTuesdayMessage() {
  console.log('🔍 שלישי 23:00 — בודק רשימה...');
  const data = loadData();
  if (!data.lastWeeklyListText) { console.log('❌ אין רשימה שמורה'); return; }
  const hoursSince = (Date.now() - new Date(data.lastWeeklyListTime).getTime()) / 3600000;
  if (hoursSince > 12) { console.log('⚠️ הרשימה ישנה מדי'); return; }
  const nonRegulars = extractNonRegulars(data.lastWeeklyListText);
  if (nonRegulars.length === 0) { console.log('אין לא קבועים השבוע'); return; }
  data.pendingPayments = nonRegulars;
  data.active = true;
  data.groupId = data.lastWeeklyListGroupId;
  saveData(data);
  await sendToGroup(GENERAL_MESSAGE);
  console.log(`לא קבועים: ${nonRegulars.join(', ')}`);
}

async function sendReminder() {
  console.log('📨 שולח תזכורת...');
  const data = loadData();
  if (!data.active || data.pendingPayments.length === 0) {
    console.log('אין חובות פתוחים');
    data.active = false;
    saveData(data);
    return;
  }
  await sendToGroup(buildReminderMessage(data.pendingPayments));
}

// ==================== Cron ====================
function setupCronJobs() {
  cron.schedule('0 23 * * 2', sendTuesdayMessage, { timezone: 'Asia/Jerusalem' });
  cron.schedule('0 9 * * 3', sendReminder, { timezone: 'Asia/Jerusalem' });
  cron.schedule('0 9 * * 4', sendReminder, { timezone: 'Asia/Jerusalem' });
  cron.schedule('0 21 * * 4', sendReminder, { timezone: 'Asia/Jerusalem' });
  console.log('⏰ לוח זמנים מוגדר');
}

// ==================== דף ניהול ====================
http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://localhost');

  if (parsed.pathname === '/remove' && parsed.searchParams.get('name')) {
    const name = parsed.searchParams.get('name');
    const data = loadData();
    data.pendingPayments = data.pendingPayments.filter(n => n !== name);
    saveData(data);
    res.writeHead(302, { Location: '/' }); res.end(); return;
  }

  if (parsed.pathname === '/stop') {
    const data = loadData();
    data.active = false; data.pendingPayments = [];
    saveData(data);
    res.writeHead(302, { Location: '/' }); res.end(); return;
  }

  if (parsed.pathname === '/send-general') {
    sendToGroup(GENERAL_MESSAGE);
    res.writeHead(302, { Location: '/' }); res.end(); return;
  }

  if (parsed.pathname === '/send-reminder') {
    const data = loadData();
    if (data.pendingPayments.length > 0) sendToGroup(buildReminderMessage(data.pendingPayments));
    res.writeHead(302, { Location: '/' }); res.end(); return;
  }

  if (parsed.pathname === '/test-scan') {
    sendTuesdayMessage();
    res.writeHead(302, { Location: '/' }); res.end(); return;
  }

  if (parsed.pathname === '/paste-list' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const text = params.get('text') || '';
      if (text.includes('קבוצה 1') && text.includes('קבוצה 2')) {
        const data = loadData();
        data.lastWeeklyListText = text;
        data.lastWeeklyListTime = new Date().toISOString();
        if (!data.lastWeeklyListGroupId) data.lastWeeklyListGroupId = data.groupId;
        saveData(data);
        console.log('📋 רשימה הוכנסה ידנית');
      }
      res.writeHead(302, { Location: '/' }); res.end();
    });
    return;
  }

  // QR page
  if (currentQR) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><body style="text-align:center;padding:40px;font-family:sans-serif">
      <h2>סרוק עם וואטסאפ</h2>
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentQR)}" />
      <p>רענן את הדף אם פג תוקף</p></body></html>`);
    return;
  }

  // Dashboard
  const data = loadData();
  const pendingRows = data.pendingPayments.length === 0
    ? '<p>✅ כולם שילמו!</p>'
    : data.pendingPayments.map(name => `
        <div style="display:flex;align-items:center;gap:12px;margin:8px 0">
          <span style="font-size:18px">${name}</span>
          <a href="/remove?name=${encodeURIComponent(name)}"
             style="background:#e74c3c;color:white;padding:6px 14px;border-radius:6px;text-decoration:none"
             onclick="return confirm('לסמן את ${name} כשילם?')">שילם במזומן ✓</a>
        </div>`).join('');

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<html><body style="font-family:sans-serif;padding:30px;direction:rtl">
    <h2>⚽ בוט תזכורת תשלום</h2>
    <p>סטטוס וואטסאפ: ${isConnected ? '🟢 מחובר' : '🔴 לא מחובר'}</p>
    <p>סטטוס בוט: ${data.active ? '🟢 פעיל' : '🔴 לא פעיל'}</p>
    <p>רשימה שמורה: ${data.lastWeeklyListTime ? new Date(data.lastWeeklyListTime).toLocaleString('he-IL') : 'אין'}</p>
    <h3>ממתינים לתשלום:</h3>
    ${pendingRows}
    ${data.active && data.pendingPayments.length > 0 ? `
      <br><a href="/stop" style="background:#888;color:white;padding:8px 16px;border-radius:6px;text-decoration:none"
         onclick="return confirm('לעצור הודעות השבוע?')">עצור הודעות השבוע</a>` : ''}
    <br><br>
    <h3>שליחה ידנית (גיבוי):</h3>
    <a href="/send-general" style="background:#e67e22;color:white;padding:8px 16px;border-radius:6px;text-decoration:none;margin-left:8px"
       onclick="return confirm('לשלוח הודעה כללית?')">שלח הודעה כללית</a>
    <a href="/send-reminder" style="background:#e74c3c;color:white;padding:8px 16px;border-radius:6px;text-decoration:none"
       onclick="return confirm('לשלוח תזכורת עם שמות?')">שלח תזכורת עם שמות</a>
    <br><br>
    <h3>הדבק רשימה שבועית ידנית (גיבוי):</h3>
    <form method="POST" action="/paste-list">
      <textarea name="text" rows="15" cols="40" placeholder="הדבק כאן את הרשימה מהוואטסאפ..." style="font-family:monospace;direction:rtl;width:100%;max-width:400px"></textarea>
      <br><button type="submit" style="background:#27ae60;color:white;padding:8px 16px;border-radius:6px;border:none;cursor:pointer;margin-top:8px">שמור רשימה</button>
    </form>
    <br><small>רענן את הדף לעדכון</small>
  </body></html>`);
}).listen(process.env.PORT || 3000, () => {
  console.log('🌐 שרת HTTP פעיל');
});

connectToWhatsApp();
