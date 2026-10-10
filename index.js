const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    Browsers
} = require('@whiskeysockets/baileys');

const { handleCommand } = require('./commands');
const config = require('./config');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');

const logger = pino({ level: 'fatal' });
const msgRetryCounterCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });

let isStarting = false;
let reconnectTimer = null;
let pairingRequested = false;
let isShuttingDown = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scheduleReconnect(delayMs = 3000) {
    if (isShuttingDown || reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToWA().catch((err) => {
            console.error('Restart error:', err.message);
            scheduleReconnect(5000);
        });
    }, delayMs);
}

async function connectToWA() {
    if (isStarting || isShuttingDown) return;
    isStarting = true;

    try {
        console.log(`Connecting ${config.botName} WhatsApp Bot...`);

        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`Using WA v${version.join('.')}, isLatest:${isLatest}`);

        const sessionDir = path.join(__dirname, 'session');
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const sock = makeWASocket({
            version,
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: true,
            browser: Browsers.macOS("Safari"),
            generateHighQualityLinkPreview: true,
            syncFullHistory: true,
            markOnlineOnConnect: true,
            msgRetryCounterCache,
            getMessage: async () => {
                return { conversation: 'Hello' };
            }
        });

        isStarting = false;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (
                connection === 'connecting' &&
                !state.creds.registered &&
                !pairingRequested
            ) {
                pairingRequested = true;
                let phoneNumber = config.pairingNumber ? config.pairingNumber.replace(/\D/g, '') : '';

                if (phoneNumber) {
                    try {
                        await delay(3000);
                        console.log(`Requesting pairing code for ${phoneNumber}...`);
                        const code = await sock.requestPairingCode(phoneNumber);
                        console.log(`\n========================================`);
                        console.log(`✨ YOUR PAIRING CODE: ${code?.match(/.{1,4}/g)?.join('-') || code} ✨`);
                        console.log(`========================================\n`);
                    } catch (err) {
                        console.error('Pairing code error:', err.message);
                    }
                } else {
                    console.log('Scan the QR code printed above in the terminal or set PAIRING_NUMBER.');
                }
            }

            if (connection === 'open') {
                console.log(`✨ ${config.botName} Connected Successfully! ✨`);
                pairingRequested = false;
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                console.log(`Connection closed. Status Code: ${statusCode ?? 'Unknown'}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('Logged out. Delete the /session folder and re-pair.');
                } else if (shouldReconnect) {
                    console.log('Reconnecting in 3 seconds...');
                    scheduleReconnect(3000);
                }
            }
        });

        sock.ev.on('messages.upsert', async (chatUpdate) => {
            const messages = chatUpdate.messages || [];

            for (const mek of messages) {
                try {
                    if (!mek.message || !mek.key?.remoteJid) continue;

                    const from = mek.key.remoteJid;
                    const isGroup = from.endsWith('@g.us');
                    const botNumber = (sock.user?.id || '').split(':')[0].split('@')[0];

                    const conn = sock;
                    const isFromMe = mek.key.fromMe;
                    const senderJid = isGroup ? (mek.key.participant || from) : from;

                    let isOwner = isFromMe;
                    if (!isOwner && senderJid) {
                        const owners = Array.isArray(config.ownerNumber) ? config.ownerNumber : [];
                        isOwner = owners.some((num) => senderJid.includes(String(num)));
                    }

                    const sms = (client, msg) => ({
                        download: async () =>
                            downloadMediaMessage(msg, 'buffer', {}, { logger: client.logger })
                    });

                    if (!isOwner && config.ANTI_DELETE !== 'off') {
                        if (!mek.key.id?.startsWith('BAE5')) {
                            const baseDir = 'message_data';
                            if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir);

                            function loadChatData(remoteJid, messageId) {
                                const chatFilePath = path.join(baseDir, remoteJid, `${messageId}.json`);
                                try {
                                    return JSON.parse(fs.readFileSync(chatFilePath, 'utf8')) || [];
                                } catch (_) {
                                    return [];
                                }
                            }

                            function saveChatData(remoteJid, messageId, chatData) {
                                const chatDir = path.join(baseDir, remoteJid);
                                if (!fs.existsSync(chatDir)) fs.mkdirSync(chatDir, { recursive: true });
                                try {
                                    fs.writeFileSync(path.join(chatDir, `${messageId}.json`), JSON.stringify(chatData, null, 2));
                                } catch (err) {
                                    console.error('Error saving chat data:', err.message);
                                }
                            }

                            function handleIncomingMessage(message) {
                                const chatData = loadChatData(from, message.key.id);
                                chatData.push(message);
                                saveChatData(from, message.key.id, chatData);
                            }

                            const delfrom = config.DELETEMSGSENDTO !== '' ? config.DELETEMSGSENDTO + '@s.whatsapp.net' : from;

                            async function handleMessageRevocation(revocationMessage) {
                                const messageId = revocationMessage.message.protocolMessage.key.id;
                                const originalMessage = loadChatData(from, messageId)[0];
                                if (!originalMessage) return;

                                const deletedByJid = revocationMessage.key.participant || revocationMessage.key.remoteJid;
                                const sentByJid = originalMessage.key.participant || originalMessage.key.remoteJid;
                                const deletedByNumber = (deletedByJid || '').replace(/@.*/, '');
                                const sentByNumber = (sentByJid || '').replace(/@.*/, '');

                                const sriLankaDateTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' });

                                if (deletedByNumber.includes(botNumber) || sentByNumber.includes(botNumber)) return;

                                const deleteInfo = `🕒 *Time:* _${sriLankaDateTime}_\n*🚮 Deleted by:* @${deletedByNumber}\n*📩 Sent by:* @${sentByNumber}\n\n`;
                                const mentions = [deletedByJid, sentByJid].filter(Boolean);
                                const original = originalMessage.message;

                                if (original.conversation || original.extendedTextMessage) {
                                    const messageText = original.conversation || original.extendedTextMessage?.text || '';
                                    await conn.sendMessage(delfrom, {
                                        text: `*🚫 Message Deleted !!*\n\n${deleteInfo}> 🔓 Text: \`\`\`${messageText}\`\`\``,
                                        mentions
                                    });
                                } else if (original.imageMessage) {
                                    const media = await sms(conn, originalMessage).download();
                                    await conn.sendMessage(delfrom, {
                                        image: media,
                                        caption: `*🚫 Image Deleted !!*\n\n${deleteInfo}`,
                                        mentions
                                    });
                                }
                            }

                            const isRevoke = mek.message.protocolMessage && mek.message.protocolMessage.type === 0;

                            if (
                                (config.ANTI_DELETE === 'inbox' && !isGroup) ||
                                (config.ANTI_DELETE === 'group' && isGroup) ||
                                (config.ANTI_DELETE === 'group&inbox')
                            ) {
                                if (isRevoke) {
                                    await handleMessageRevocation(mek);
                                } else {
                                    handleIncomingMessage(mek);
                                }
                            }
                        }
                    }

                    if (from === 'status@broadcast') {
                        if (config.autoStatusView) {
                            try {
                                await sock.readMessages([mek.key]);
                                if (config.statusEmoji) {
                                    await sock.sendMessage(
                                        from,
                                        { react: { text: config.statusEmoji, key: mek.key } },
                                        { statusJidList: [mek.key.participant].filter(Boolean) }
                                    );
                                }
                            } catch (err) {
                                console.log('Status Error:', err.message);
                            }
                        }
                        continue;
                    }

                    if (config.autoRead) {
                        try {
                            await sock.readMessages([mek.key]);
                        } catch (err) {
                            console.log('Auto-read Error:', err.message);
                        }
                    }

                    const messageType = Object.keys(mek.message)[0];
                    let body = '';

                    if (messageType === 'conversation') {
                        body = mek.message.conversation || '';
                    } else if (messageType === 'extendedTextMessage') {
                        body = mek.message.extendedTextMessage?.text || '';
                    } else if (messageType === 'imageMessage' && mek.message.imageMessage?.caption) {
                        body = mek.message.imageMessage.caption;
                    } else if (messageType === 'videoMessage' && mek.message.videoMessage?.caption) {
                        body = mek.message.videoMessage.caption;
                    } else if (messageType === 'documentMessage' && mek.message.documentMessage?.caption) {
                        body = mek.message.documentMessage.caption;
                    }

                    const pushName = mek.pushName || 'User';

                    await handleCommand(sock, mek, from, body, pushName);

                } catch (err) {
                    console.error('Message processing error:', err.stack || err.message || err);
                }
            }
        });

    } catch (err) {
        isStarting = false;
        console.error('Bot Connection Error:', err.stack || err.message || err);
        scheduleReconnect(5000);
    }
}

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception Detected:', err.stack || err.message || err);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection Detected:', reason);
});

process.on('SIGINT', () => {
    isShuttingDown = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    console.log(`\n${config.botName} Stopped Safely.`);
    process.exit(0);
});

connectToWA();
