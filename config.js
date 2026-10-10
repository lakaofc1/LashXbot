module.exports = {
    botName: process.env.BOT_NAME || "LashxBot",
    ownerName: process.env.OWNER_NAME || "Lashan (Lashx)",
    ownerNumber: process.env.OWNER_NUMBER ? process.env.OWNER_NUMBER.split(',') : ["94781121579"],
    pairingNumber: process.env.PAIRING_NUMBER || "94781121579",
    version: "v3.0.0",
    prefix: process.env.PREFIX || "#",
    workMode: process.env.WORK_MODE || "private", // public, private, inbox, group
    autoRead: process.env.AUTO_READ === 'true' ? true : false,
    autoStatusView: process.env.AUTO_STATUS_VIEW !== 'false', // default true
    statusEmoji: process.env.STATUS_EMOJI || "🔥",
    antiDelete: process.env.ANTI_DELETE_TOGGLE !== 'false',
    ANTI_DELETE: process.env.ANTI_DELETE || "group&inbox", // options: "off", "inbox", "group", "group&inbox"
    DELETEMSGSENDTO: process.env.DELETE_MSG_SEND_TO || "",
    MAX_SIZE: parseInt(process.env.MAX_SIZE) || 100
};
