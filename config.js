module.exports = {
    botName: "LashxBot",
    ownerName: "Lashan (Lashx)",
    ownerNumber: ["94784185833"],
    pairingNumber: process.env.PAIRING_NUMBER || "94784185833",
    version: "v3.0.0",
    prefix: "#",
    workMode: "private", // public, private, inbox, group
    autoRead: false,
    autoStatusView: true,
    statusEmoji: "🔥",
    antiDelete: true,
    ANTI_DELETE: "group&inbox", // options: "off", "inbox", "group", "group&inbox"
    DELETEMSGSENDTO: "",
    MAX_SIZE: 100
};
