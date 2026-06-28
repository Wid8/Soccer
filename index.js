const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const http = require('http');

// שרת HTTP פשוט להצגת QR
let currentQR = null;
http.createServer((req, res) => {
  if (currentQR) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html><body style="text-align:center;padding:40px">
      <h2>סרוק עם וואטסאפ</h2>
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentQR)}" />
      <p>רענן את הדף אם פג תוקף</p>
      </body></html>
    `);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h2>✅ הבוט מחובר!</h2></body></html>');
  }
}).listen(process.env.PORT || 3000, () => {
  console.log('🌐 פתח את כתובת ה-URL של Render לסריקת QR');
});

// ==================== הגדרות ====================
const GROUP_NAME = 'כדורגל ימי ג\' בהוד"ש ⚽';
const PAYBOX_LINK = 'https://links.payboxapp.com/5B58fGzSKUb';
const PAYMENT_AMOUNT = '30';
const DATA_FILE = path.join(__dirname, 'data.json');
const AUTH_FOLDER = path.join(__dirname, 'auth_info');

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

// ==================== עיבוד רשימה ====================
function extractNonRegulars(text) {
  const lines = text.split('\n');
  const allPlayers = [];
  for (const line of lines) {
    const match = line.match(/^\d+\.\s*(.+)/);
    if (match) allPlayers.push(match[1].trim());
  }
  return allPlayers.filter(name =>
    !REGULARS.some(r => name.includes(r) || r.includes(name))
  );
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

// ==================== Bot ====================
let sock;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log('📱 פתח את כתובת ה-URL של Render וסרוק את ה-QR מהדפדפן!');

    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('התנתק, מתחבר מחדש:', shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      console.log('✅ הבוט מחובר!');
      setupCronJobs();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      if (text !== 'שולם') continue;

      const data = loadData();
      if (!data.active || data.pendingPayments.length === 0) continue;
      if (msg.key.remoteJid !== data.groupId) continue;

      // מזהה שם השולח
      const sender = msg.pushName || '';
      const before = data.pendingPayments.length;
      data.pendingPayments = data.pendingPayments.filter(name =>
        !sender.includes(name) && !name.includes(sender)
      );

      if (data.pendingPayments.length < before) {
        saveData(data);
        console.log(`✅ ${sender} סומן כשילם. נותרו: ${data.pendingPayments.join(', ') || 'אף אחד'}`);
      }
    }
  });
}

// ==================== פונקציות שליחה ====================
async function getGroupId() {
  const data = loadData();
  if (data.groupId) return data.groupId;

  const groups = await sock.groupFetchAllParticipating();
  for (const [id, g] of Object.entries(groups)) {
    if (g.subject === GROUP_NAME) {
      data.groupId = id;
      saveData(data);
      return id;
    }
  }
  return null;
}

async function scanAndSendTuesday() {
  console.log('🔍 שלישי 23:00 — סורק רשימה...');
  const groupId = await getGroupId();
  if (!groupId) { console.log('❌ קבוצה לא נמצאה'); return; }

  // מביא הודעות אחרונות
  const msgs = await sock.fetchMessageHistory(20, { remoteJid: groupId }, new Date());
  let nonRegulars = [];

  for (const m of (msgs || [])) {
    const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
    if (text.includes('קבוצה 1') && text.includes('קבוצה 2')) {
      nonRegulars = extractNonRegulars(text);
      break;
    }
  }

  if (nonRegulars.length === 0) {
    console.log('אין לא קבועים השבוע');
    return;
  }

  const data = loadData();
  data.pendingPayments = nonRegulars;
  data.active = true;
  data.groupId = groupId;
  saveData(data);

  await sock.sendMessage(groupId, { text: GENERAL_MESSAGE });
  console.log(`✅ הודעה כללית נשלחה. לא קבועים: ${nonRegulars.join(', ')}`);
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
  await sock.sendMessage(data.groupId, { text: buildReminderMessage(data.pendingPayments) });
  console.log(`✅ תזכורת נשלחה ל: ${data.pendingPayments.join(', ')}`);
}

// ==================== Cron ====================
function setupCronJobs() {
  cron.schedule('0 23 * * 2', scanAndSendTuesday, { timezone: 'Asia/Jerusalem' });
  cron.schedule('0 9 * * 3', sendReminder, { timezone: 'Asia/Jerusalem' });
  cron.schedule('0 9 * * 4', sendReminder, { timezone: 'Asia/Jerusalem' });
  cron.schedule('0 21 * * 4', sendReminder, { timezone: 'Asia/Jerusalem' });
  console.log('⏰ לוח זמנים פעיל');
}

// ==================== פקודות ניהול ====================
const args = process.argv.slice(2);
if (args[0] === 'stop') {
  const data = loadData();
  data.active = false;
  data.pendingPayments = [];
  saveData(data);
  console.log('✅ הופסק');
  process.exit(0);
} else if (args[0] === 'status') {
  const data = loadData();
  console.log(`פעיל: ${data.active}\nממתינים: ${data.pendingPayments.join(', ') || 'אף אחד'}`);
  process.exit(0);
} else if (args[0] === 'paid') {
  const data = loadData();
  data.pendingPayments = data.pendingPayments.filter(n => n !== args[1]);
  saveData(data);
  console.log(`✅ ${args[1]} סומן כשילם`);
  process.exit(0);
}

connectToWhatsApp();
