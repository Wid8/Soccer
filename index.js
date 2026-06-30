const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const http = require('http');
const stringSimilarity = require('string-similarity');

// ==================== שרת HTTP + דף ניהול ====================
let currentQR = null;
const url = require('url');

http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // הסרת שם מהרשימה
  if (parsed.pathname === '/remove' && parsed.query.name) {
    const name = decodeURIComponent(parsed.query.name);
    const data = loadData();
    data.pendingPayments = data.pendingPayments.filter(n => n !== name);
    saveData(data);
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  // הדבקת רשימה ידנית
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
        if (!data.lastWeeklyListGroupId) {
          getGroupId().then(id => {
            data.lastWeeklyListGroupId = id;
            saveData(data);
          });
        } else {
          saveData(data);
        }
        console.log('📋 רשימה הוכנסה ידנית');
      }
      res.writeHead(302, { Location: '/' });
      res.end();
    });
    return;
  }

  // הרצת סריקה ידנית לבדיקה
  if (parsed.pathname === '/test-scan') {
    scanAndSendTuesday();
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  // עצירת הבוט
  if (parsed.pathname === '/stop') {
    const data = loadData();
    data.active = false;
    data.pendingPayments = [];
    saveData(data);
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }

  // דף ראשי
  const data = loadData();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

  if (currentQR) {
    res.end(`
      <html><body style="text-align:center;padding:40px;font-family:sans-serif">
      <h2>סרוק עם וואטסאפ</h2>
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentQR)}" />
      <p>רענן את הדף אם פג תוקף</p>
      </body></html>
    `);
    return;
  }

  const pendingRows = data.pendingPayments.length === 0
    ? '<p>✅ כולם שילמו!</p>'
    : data.pendingPayments.map(name => `
        <div style="display:flex;align-items:center;gap:12px;margin:8px 0">
          <span style="font-size:18px">${name}</span>
          <a href="/remove?name=${encodeURIComponent(name)}" 
             style="background:#e74c3c;color:white;padding:6px 14px;border-radius:6px;text-decoration:none"
             onclick="return confirm('לסמן את ${name} כשילם?')">שילם במזומן ✓</a>
        </div>
      `).join('');

  res.end(`
    <html><body style="font-family:sans-serif;padding:30px;direction:rtl">
    <h2>⚽ בוט תזכורת תשלום</h2>
    <p>סטטוס: ${data.active ? '🟢 פעיל' : '🔴 לא פעיל'}</p>
    <p>רשימה שבועית אחרונה שנשמרה: ${data.lastWeeklyListTime ? new Date(data.lastWeeklyListTime).toLocaleString('he-IL') : 'אף פעם'}</p>
    <h3>ממתינים לתשלום:</h3>
    ${pendingRows}
    ${data.active && data.pendingPayments.length > 0 ? `
      <br><a href="/stop" style="background:#888;color:white;padding:8px 16px;border-radius:6px;text-decoration:none"
         onclick="return confirm('לעצור את כל ההודעות השבוע?')">עצור הודעות השבוע</a>
    ` : ''}
    <br><br><a href="/test-scan" style="background:#3498db;color:white;padding:8px 16px;border-radius:6px;text-decoration:none">בדוק סריקה עכשיו (טסט)</a>
    <br><br>
    <h3>הדבק רשימה שבועית ידנית:</h3>
    <form method="POST" action="/paste-list">
      <textarea name="text" rows="15" cols="40" placeholder="הדבק כאן את הרשימה מהוואטסאפ..." style="font-family:monospace;direction:rtl;width:100%;max-width:400px"></textarea>
      <br><button type="submit" style="background:#27ae60;color:white;padding:8px 16px;border-radius:6px;border:none;cursor:pointer;margin-top:8px">שמור רשימה</button>
    </form>
    <br><small>רענן את הדף לעדכון</small>
    </body></html>
  `);
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

      // ==================== שמירת רשימה שבועית בזמן אמת ====================
      if (!isPrivate && text.includes('קבוצה 1') && text.includes('קבוצה 2')) {
        data.lastWeeklyListText = text;
        data.lastWeeklyListGroupId = msg.key.remoteJid;
        data.lastWeeklyListTime = new Date().toISOString();
        saveData(data);
        console.log(`📋 רשימה שבועית נשמרה (${new Date().toLocaleString('he-IL')})`);
      }
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
  console.log('🔍 שלישי 23:00 — בודק רשימה שמורה...');
  const data = loadData();

  if (!data.lastWeeklyListText) {
    console.log('❌ לא נמצאה רשימה שבועית שמורה. ודא שחברך פרסם את הרשימה לפני 23:00 וה-בוט היה מחובר.');
    return;
  }

  // ודא שהרשימה מהיום (לא משבוע קודם)
  const listDate = new Date(data.lastWeeklyListTime);
  const hoursSinceList = (Date.now() - listDate.getTime()) / (1000 * 60 * 60);
  if (hoursSinceList > 12) {
    console.log(`⚠️ הרשימה השמורה ישנה מדי (${Math.round(hoursSinceList)} שעות). לא נשלחת הודעה.`);
    return;
  }

  const nonRegulars = extractNonRegulars(data.lastWeeklyListText);
  console.log(`📋 לא קבועים שזוהו: ${nonRegulars.join(', ') || 'אף אחד'}`);

  if (nonRegulars.length === 0) {
    console.log('אין לא קבועים השבוע');
    return;
  }

  const groupId = data.lastWeeklyListGroupId || await getGroupId();
  if (!groupId) { console.log('❌ קבוצה לא נמצאה'); return; }

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
let cronJobsSet = false;
function setupCronJobs() {
  if (cronJobsSet) { console.log('⏰ לוח זמנים כבר פעיל, מדלג'); return; }
  cronJobsSet = true;
  cron.schedule('0 23 * * 2', scanAndSendTuesday, { timezone: 'Asia/Jerusalem' });
  cron.schedule('0 9 * * 3', sendReminder, { timezone: 'Asia/Jerusalem' });
  cron.schedule('0 9 * * 4', sendReminder, { timezone: 'Asia/Jerusalem' });
  cron.schedule('0 21 * * 4', sendReminder, { timezone: 'Asia/Jerusalem' });
  console.log('⏰ לוח זמנים מוגדר');
}

connectToWhatsApp();
