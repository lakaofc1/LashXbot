module.exports = {
    botName: process.env.BOT_NAME || "LashxBot",
    ownerName: process.env.OWNER_NAME || "Lashan (Lashx)",
    ownerNumber: process.env.OWNER_NUMBER ? process.env.OWNER_NUMBER.split(',') : ["94781121579"],
    pairingNumber: process.env.PAIRING_NUMBER || "94781121579",
    sessionId: process.env.SESSION_ID || "",
    version: "v3.0.0",
    prefix: process.env.PREFIX || "#",
    workMode: process.env.WORK_MODE || "private",
    autoRead: process.env.AUTO_READ === 'true',
    autoStatusView: process.env.AUTO_STATUS_VIEW !== 'false',
    statusEmoji: process.env.STATUS_EMOJI || "🔥",
    antiDelete: process.env.ANTI_DELETE_TOGGLE !== 'false',
    ANTI_DELETE: process.env.ANTI_DELETE || "group&inbox",
    DELETEMSGSENDTO: process.env.DELETE_MSG_SEND_TO || "",
    MAX_SIZE: parseInt(process.env.MAX_SIZE) || 100,
    antiLink: process.env.ANTI_LINK !== 'false',
    antiBad: process.env.ANTI_BAD === 'true',

    // 🌟 අලුතින් එකතු කළ Auto Features
    alwaysOnline: process.env.ALWAYS_ONLINE !== 'false', // Default: true (හැමවෙලේම Online පෙන්නයි)
    autoTyping: process.env.AUTO_TYPING === 'true',      // Default: false (Typing පෙන්නන්න ඕන නම් true කරන්න)
    autoRecording: process.env.AUTO_RECORDING === 'true' // Default: false (Recording පෙන්නන්න ඕන නම් true කරන්න)
};
