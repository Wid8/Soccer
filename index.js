const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const fs = require('fs-extra');
const path = require('path');

// ==================== הגדרות ====================
const GROUP_NAME = 'כדורגל ימי ג\' בהוד"ש ⚽';
const PAYBOX_LINK = 'https://links.payboxapp.com/5B58fGzSKUb';
const PAYMENT_AMOUNT = '30';
const DATA_FILE = path.join(__dirname, 'data.json');

const REGULARS = [
  'אייל קרוואני', 'אסף', 'אורן', 'דורון', 'תומר לבון',
  'דביר', 'אופק', 'זיו', 'גיא', 'מור', 'אבי', 'שגיא',
  'סרגיי', 'רועי', 'טל וידרמן', 'שמעון', 'סהר', 'ג\'רזי',
  'ודים', 'הראל ליסון'
];

// ==================== ניהול נתונים ====================
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return fs.readJsonSync(DATA_FILE);
    }
  } catch (e) {}
  return { pendingPayments: [], active: false, lastGameDate: null };
}

function saveData(data) {
  fs.writeJsonSync(DATA_FILE, data, { spaces: 2 });
}

// ==================== עיבוד רשימה ====================
function extractNonRegularsFromMessage(text) {
  const lines = text.split('\n');
  const allPlayers = [];

  for (const line of lines) {
    const match = line.match(/^\d+\.\s*(.+)/);
    if (match) {
      const name = match[1].trim();
      allPlayers.push(name);
    }
  }

  const nonRegulars = allPlayers.filter(name => {
    return !REGULARS.some(regular =>
      name.includes(regular) || regular.includes(name)
    );
  });

  return nonRegulars;
}

// ==================== הודעות ====================
const GENERAL_MESSAGE = `⚽ בוט תזכורת תשלום ⚽

מי שהשתתף במשחק הערב ואינו ברשימת הקבועים — נא להעביר ${PAYMENT_AMOUNT} ש״ח לפייבוקס של הקבוצה:
${PAYBOX_LINK}

מי ששילם — שיכתוב "שולם" בקבוצה 🙏`;

function buildReminderMessage(pending) {
  const namesList = pending.map(name => `• ${name}`).join('\n');
  return `⚽ בוט תזכורת תשלום ⚽

המשתתפים הבאים טרם העבירו תשלום עבור המשחק:
${namesList}

נא להעביר ${PAYMENT_AMOUNT} ש״ח לפייבוקס:
${PAYBOX_LINK}

מי ששילם — שיכתוב "שולם" בקבוצה 🙏`;
}

// ==================== WhatsApp Client ====================
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log('\n📱 סרוק את הקוד הבא עם הוואטסאפ שלך:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ הבוט מחובר ומוכן!');
  setupCronJobs();
});

client.on('auth_failure', () => {
  console.error('❌ שגיאת אימות — נסה שוב');
});

// ==================== מאזין ל"שולם" ====================
client.on('message', async (msg) => {
  const data = loadData();
  if (!data.active || data.pendingPayments.length === 0) return;

  const text = msg.body.trim();
  if (text !== 'שולם') return;

  const chat = await msg.getChat();
  if (!chat.isGroup) return;
  if (chat.name !== GROUP_NAME) return;

  const contact = await msg.getContact();
  const senderName = contact.pushname || contact.name || '';

  const before = data.pendingPayments.length;
  data.pendingPayments = data.pendingPayments.filter(name =>
    !senderName.includes(name) && !name.includes(senderName)
  );

  if (data.pendingPayments.length < before) {
    saveData(data);
    console.log(`✅ ${senderName} סומן כשילם. נותרו: ${data.pendingPayments.join(', ') || 'אף אחד'}`);
  }
});

// ==================== פונקציות שליחה ====================
async function getGroup() {
  const chats = await client.getChats();
  return chats.find(c => c.isGroup && c.name === GROUP_NAME);
}

async function scanWeeklyList() {
  console.log('🔍 סורק רשימה שבועית...');
  const group = await getGroup();
  if (!group) {
    console.log('❌ קבוצה לא נמצאה');
    return null;
  }

  const messages = await group.fetchMessages({ limit: 50 });
  const tuesday = new Date();
  tuesday.setHours(0, 0, 0, 0);

  // מחפש הודעה עם רשימת שחקנים מהיום
  for (const msg of messages.reverse()) {
    const msgDate = new Date(msg.timestamp * 1000);
    if (msgDate < tuesday) continue;

    if (msg.body.includes('קבוצה 1') && msg.body.includes('קבוצה 2')) {
      const nonRegulars = extractNonRegularsFromMessage(msg.body);
      console.log(`📋 נמצאו לא קבועים: ${nonRegulars.join(', ') || 'אף אחד'}`);
      return nonRegulars;
    }
  }

  console.log('⚠️ לא נמצאה רשימה שבועית');
  return null;
}

async function sendTuesdayMessage() {
  console.log('📨 שולח הודעת שלישי...');

  const nonRegulars = await scanWeeklyList();
  if (!nonRegulars || nonRegulars.length === 0) {
    console.log('אין לא קבועים השבוע, לא שולח הודעה');
    return;
  }

  const data = loadData();
  data.pendingPayments = nonRegulars;
  data.active = true;
  data.lastGameDate = new Date().toISOString();
  saveData(data);

  const group = await getGroup();
  if (!group) return;

  await group.sendMessage(GENERAL_MESSAGE);
  console.log('✅ הודעה כללית נשלחה');
}

async function sendDailyReminder() {
  console.log('📨 שולח תזכורת יומית...');
  const data = loadData();

  if (!data.active || data.pendingPayments.length === 0) {
    console.log('אין חובות פתוחים, לא שולח הודעה');
    data.active = false;
    saveData(data);
    return;
  }

  const group = await getGroup();
  if (!group) return;

  const message = buildReminderMessage(data.pendingPayments);
  await group.sendMessage(message);
  console.log(`✅ תזכורת נשלחה ל: ${data.pendingPayments.join(', ')}`);
}

// ==================== Cron Jobs ====================
function setupCronJobs() {
  // שלישי 23:00 - סריקה + הודעה כללית
  cron.schedule('0 23 * * 2', sendTuesdayMessage, { timezone: 'Asia/Jerusalem' });

  // רביעי 9:00
  cron.schedule('0 9 * * 3', sendDailyReminder, { timezone: 'Asia/Jerusalem' });

  // חמישי 9:00
  cron.schedule('0 9 * * 4', sendDailyReminder, { timezone: 'Asia/Jerusalem' });

  // חמישי 21:00
  cron.schedule('0 21 * * 4', sendDailyReminder, { timezone: 'Asia/Jerusalem' });

  console.log('⏰ לוח זמנים מוגדר:');
  console.log('  שלישי 23:00 - סריקה + הודעה כללית');
  console.log('  רביעי 09:00 - תזכורת');
  console.log('  חמישי 09:00 - תזכורת');
  console.log('  חמישי 21:00 - תזכורת אחרונה');
}

// ==================== פקודות ניהול ====================
// הפעלה ידנית מהטרמינל לצורכי בדיקה
const args = process.argv.slice(2);
if (args[0] === 'test-tuesday') {
  client.on('ready', async () => {
    await sendTuesdayMessage();
    process.exit(0);
  });
} else if (args[0] === 'test-reminder') {
  client.on('ready', async () => {
    await sendDailyReminder();
    process.exit(0);
  });
} else if (args[0] === 'stop') {
  const data = loadData();
  data.active = false;
  data.pendingPayments = [];
  saveData(data);
  console.log('✅ הבוט הופסק, לא ישלח יותר הודעות השבוע');
  process.exit(0);
} else if (args[0] === 'status') {
  const data = loadData();
  console.log('📊 סטטוס נוכחי:');
  console.log(`  פעיל: ${data.active}`);
  console.log(`  ממתינים לתשלום: ${data.pendingPayments.join(', ') || 'אף אחד'}`);
  process.exit(0);
} else if (args[0] === 'paid') {
  const name = args[1];
  if (!name) {
    console.log('שימוש: node index.js paid "שם"');
    process.exit(1);
  }
  const data = loadData();
  data.pendingPayments = data.pendingPayments.filter(n => n !== name);
  saveData(data);
  console.log(`✅ ${name} סומן כשילם`);
  process.exit(0);
}

client.initialize();
