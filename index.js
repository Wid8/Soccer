const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const http = require('http');
const stringSimilarity = require('string-similarity');

// ==================== שרת HTTP להצגת QR ====================
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
  console.log('🌐 שרת HTTP פעיל');
});

// ==================== הגדרות ====================
const GROUP_NAME = 'כדורגל ימי ג\' בהוד"ש ⚽';
const PAYBOX_LINK = 'https://links.payboxapp.com/5B58fGzSKUb';
const PAYMENT_AMOUNT = '30';
const DATA_FILE = path.join(__dirname, 'data.json');
const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const SIMILARITY_THRESHOLD = 0.75; // רגישות זיהוי שמות (0-1)

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
  return { pendingPayments: [], active: false, groupId: null, adminId: null };
}

function saveData(data) {
  fs.writeJsonSync(DATA_FILE, data, { spaces: 2 });
}

// ==================== זיהוי חכם של שמות ====================
function isSimilarToRegular(name) {
  for (const regular of REGULARS) {
    // בדיקה ישירה
    if (name.includes(regular) || regular.includes(name)) return true;
    // בדיקת דמיון
    const similarity = stringSimilarity.compareTwoStrings(name, regular);
    if (similarity >= SIMILARITY_THRESHOLD) {
      console.log(`🔍 זיהוי חכם: "${name}" ≈ "${regular}" (${Math.round(similarity * 100)}%)`);
      return true;
    }
  }
  return false;
}

function isSimilarToPending(sender, pendingList) {
  for (const name of pendingList) {
    if (sender.includes(name) || name.includes(sender)) return name;
    const similarity = stringSimilarity.compareTwoStrings(sender, name);
    if (similarity >= SIMILARITY_THRESHOLD) {
      console.log(`🔍 זיהוי חכם תשלום: "${sender}" ≈ "${name}" (${Math.round(similarity * 100)}%)`);
      return name;
    }
  }
  return null;
}

// ==================== עיבוד רשימה ====================
function extractNonRegulars(text) {
  const lines = text.split('\n');
  const allPlayers = [];
  for (const line of lines) {
    const match = line.match(/^\d+\.\s*(.+)/);
    if (match) allPlayers.push(match[1].trim());
  }
  return allPlayers.filter(name => !isSimilarToRegular(name));
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
let adminJid = null;

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
      console.log('📱 פתח את ה-URL לסריקת QR');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      currentQR = null;
      console.log('✅ הבוט מחובר!');
      setupCronJobs();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      const sender = msg.pushName || '';
      const isPrivate = !msg.key.remoteJid.includes('@g.us');
      const data = loadData();

      // ==================== הודעות פרטיות לניהול ====================
      if (isPrivate) {
        // שמור את ה-admin (מי שמתקשר ראשון)
        if (!data.adminId) {
          data.adminId = msg.key.remoteJid;
          saveData(data);
          adminJid = data.adminId;
          console.log(`👤 Admin הוגדר: ${sender}`);
        }

        if (msg.key.remoteJid !== data.adminId) continue;

        // פקודה: שולם [שם]
        if (text.startsWith('שולם ')) {
          const name = text.replace('שולם ', '').trim();
          const matched = isSimilarToPending(name, data.pendingPayments);
          if (matched) {
            data.pendingPayments = data.pendingPayments.filter(n => n !== matched);
            saveData(data);
            await sock.sendMessage(msg.key.remoteJid, { text: `✅ ${matched} הוסר מהרשימה. נותרו: ${data.pendingPayments.join(', ') || 'אף אחד'}` });
          } else {
            await sock.sendMessage(msg.key.remoteJid, { text: `❌ לא נמצא "${name}" ברשימה. רשימה נוכחית: ${data.pendingPayments.join(', ')}` });
          }
        }

        // פקודה: סטטוס
        else if (text === 'סטטוס') {
          await sock.sendMessage(msg.key.remoteJid, {
            text: `📊 סטטוס:\nפעיל: ${data.active}\nממתינים לתשלום: ${data.pendingPayments.join(', ') || 'אף אחד'}`
          });
        }

        // פקודה: עצור
        else if (text === 'עצור') {
          data.active = false;
          data.pendingPayments = [];
          saveData(data);
          await sock.sendMessage(msg.key.remoteJid, { text: '✅ הבוט הופסק, לא ישלח הודעות השבוע' });
        }

        continue;
      }

      // ==================== הודעות בקבוצה ====================
      if (!data.active || data.pendingPayments.length === 0) continue;
      if (msg.key.remoteJid !== data.groupId) continue;
      if (text !== 'שולם') continue;

      const matched = isSimilarToPending(sender, data.pendingPayments);
      if (matched) {
        data.pendingPayments = data.pendingPayments.filter(n => n !== matched);
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

connectToWhatsApp();
