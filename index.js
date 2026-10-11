const {
    default: makeWASocket,
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
const { useMongoDBAuthState, loadBotSettings } = require('./mongodb-auth');
const NodeCache = require('node-cache');

const logger = pino({ level: 'fatal' });
const msgRetryCounterCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });

let isStarting = false;
let reconnectTimer = null;
let pairingPromptHandled = false;
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

function unwrapMessageContent(message) {
    let current = message || {};
    // Baileys wraps some messages (ephemeral, view-once, document-with-caption).
    for (let i = 0; i < 5; i++) {
        const next = current.ephemeralMessage?.message ||
            current.viewOnceMessage?.message ||
            current.viewOnceMessageV2?.message ||
            current.viewOnceMessageV2Extension?.message ||
            current.documentWithCaptionMessage?.message;
        if (!next) break;
        current = next;
    }
    return current;
}

function getTextFromMessage(message) {
    const content = unwrapMessageContent(message);
    return content.conversation || content.extendedTextMessage?.text ||
        content.imageMessage?.caption || content.videoMessage?.caption ||
        content.documentMessage?.caption || content.documentWithCaptionMessage?.message?.documentMessage?.caption || '';
}

function normalizeJid(jid) {
    if (!jid) return '';
    const [user] = String(jid).split(':');
    return user.includes('@') ? user : `${user}@s.whatsapp.net`;
}

async function connectToWA() {
    if (isStarting || isShuttingDown) return;
    isStarting = true;

    try {
        console.log(`Connecting ${config.botName} WhatsApp Bot...`);

        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`Using WA v${version.join('.')}, isLatest:${isLatest}`);

        // Credentials and Signal keys are persisted in MongoDB, not Heroku's ephemeral disk.
        const { state, saveCreds } = await useMongoDBAuthState();
        try {
            const savedSettings = await loadBotSettings();
            if (savedSettings) Object.assign(config, savedSettings);
        } catch (settingsErr) { console.error('Could not load saved bot settings:', settingsErr.message); }

        const sock = makeWASocket({
            version,
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: false,
            browser: Browsers.macOS("Safari"),
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: config.alwaysOnline,
            msgRetryCounterCache,
            getMessage: async () => {
                return { conversation: 'Hello' };
            }
        });

        isStarting = false;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            // Panel එකේදී Pairing Code එක Automatic ලබාදීම
            if (
                connection === 'connecting' &&
                !state.creds.registered &&
                !pairingPromptHandled
            ) {
                pairingPromptHandled = true;
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
                }
            }

            if (connection === 'open') {
                console.log(`✨ ${config.botName} Connected Successfully! ✨`);
                pairingPromptHandled = false;
                if (config.alwaysOnline) {
                    await sock.sendPresenceUpdate('available');
                }
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

                    // 🛑 Anti-Delete Logic Execution
                    if (config.ANTI_DELETE !== 'off') {
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
                                const original = unwrapMessageContent(originalMessage.message);
                                const messageText = getTextFromMessage(original);
                                const textBlock = messageText ? `> 🔓 Text: \`\`\`${messageText}\`\`\`\n\n` : '';

                                if (original.conversation || original.extendedTextMessage) {
                                    await conn.sendMessage(delfrom, {
                                        text: `*🚫 Message Deleted !!*\n\n${deleteInfo}${textBlock}`,
                                        mentions
                                    });
                                } else {
                                    // Recover common media types when WhatsApp still allows the media to be downloaded.
                                    try {
                                        const media = await sms(conn, originalMessage).download();
                                        const kind = Object.keys(original).find((key) => key.endsWith('Message')) || 'message';
                                        const caption = `*🚫 ${kind.replace('Message', '').replace(/^./, c => c.toLowerCase())} Deleted !!*\n\n${deleteInfo}${textBlock}`;
                                        let resentMessage = null;
                                        if (original.imageMessage) { resentMessage = await conn.sendMessage(delfrom, { image: media, caption, mentions }); }
                                        else if (original.videoMessage) { resentMessage = await conn.sendMessage(delfrom, { video: media, caption, mentions, mimetype: original.videoMessage.mimetype }); }
                                        else if (original.audioMessage) { resentMessage = await conn.sendMessage(delfrom, { audio: media, mimetype: original.audioMessage.mimetype || 'audio/ogg; codecs=opus', ptt: !!original.audioMessage.ptt }); }
                                        else if (original.stickerMessage) { resentMessage = await conn.sendMessage(delfrom, { sticker: media }); }
                                        else if (original.documentMessage) { resentMessage = await conn.sendMessage(delfrom, { document: media, mimetype: original.documentMessage.mimetype || 'application/octet-stream', fileName: original.documentMessage.fileName || 'deleted-file', caption, mentions }); }
                                        else if (original.contactMessage) { resentMessage = await conn.sendMessage(delfrom, { contacts: { displayName: original.contactMessage.displayName || 'Contact', contacts: [{ vcard: original.contactMessage.vcard || '' }] } }); }
                                        else if (original.contactsArrayMessage) { resentMessage = await conn.sendMessage(delfrom, { text: JSON.stringify(original.contactsArrayMessage), mentions }); }
                                        else if (original.locationMessage) { resentMessage = await conn.sendMessage(delfrom, { location: { degreesLatitude: original.locationMessage.degreesLatitude, degreesLongitude: original.locationMessage.degreesLongitude, name: original.locationMessage.name, address: original.locationMessage.address } }); }
                                        else if (original.liveLocationMessage) { resentMessage = await conn.sendMessage(delfrom, { location: { degreesLatitude: original.liveLocationMessage.degreesLatitude, degreesLongitude: original.liveLocationMessage.degreesLongitude, name: 'Live location (last received position)' } }); }
                                        else { resentMessage = await conn.sendMessage(delfrom, { text: `${caption}\nThis message type has no supported resend format.`, mentions }); }

                                        // For message types that cannot carry a caption, send the delete details
                                        // as a reply to the resent media/contact/location so the context stays attached.
                                        const needsReplyDetails = original.audioMessage || original.stickerMessage || original.contactMessage || original.contactsArrayMessage || original.locationMessage || original.liveLocationMessage;
                                        if (resentMessage && needsReplyDetails) {
                                            await conn.sendMessage(delfrom, { text: caption, mentions }, { quoted: resentMessage });
                                        }
                                    } catch (mediaErr) {
                                        console.error('Anti-delete media recovery failed:', mediaErr.message);
                                        // Do not send the confusing media-key warning to the chat. If WhatsApp no longer
                                        // provides the media bytes, keep the failure only in Heroku logs.
                                        console.warn('Anti-delete could not recover media; no warning message sent.');
                                    }
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

                    // Auto Typing / Recording
                    if (config.autoTyping) {
                        await sock.sendPresenceUpdate('composing', from);
                    } else if (config.autoRecording) {
                        await sock.sendPresenceUpdate('recording', from);
                    }

                    const body = getTextFromMessage(mek.message);

                    // Group moderation: anti-link and anti-bad-word. Only delete for non-admins.
                    if (isGroup && !isOwner && body) {
                        let metadata = null;
                        try { metadata = await sock.groupMetadata(from); } catch (_) {}
                        const participants = metadata?.participants || [];
                        const isSenderAdmin = participants.some(p => normalizeJid(p.id) === normalizeJid(senderJid) && Boolean(p.admin));
                        const botJid = normalizeJid(sock.user?.id || '');
                        const isBotAdmin = participants.some(p => normalizeJid(p.id) === botJid && Boolean(p.admin));
                        if (!isSenderAdmin && isBotAdmin) {
                            const linkPattern = /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/|wa\.me\/|t\.me\/|discord\.gg\/)[^\s]+/i;
                            if (config.antiLink && linkPattern.test(body)) {
                                try {
                                    await sock.sendMessage(from, { delete: mek.key });
                                    await sock.sendMessage(from, { text: '🚫 Group links are not allowed.' }, { quoted: mek });
                                } catch (e) { console.error('Anti-link action failed:', e.message); }
                                continue;
                            }
                            if (config.antiBad) {
                                try {
                                    if (!global.__lashBadWords) {
                                        const response = await fetch('https://laka-md-databes.pages.dev/bad.json');
                                        if (response.ok) global.__lashBadWords = await response.json();
                                    }
                                    const bad = global.__lashBadWords;
                                    const words = Array.isArray(bad) ? bad : (bad && typeof bad === 'object' ? Object.values(bad) : []);
                                    const matched = words.some(word => typeof word === 'string' && word.trim() && body.toLowerCase().includes(word.toLowerCase()));
                                    if (matched && !/tent|docu|https/i.test(body)) {
                                        await sock.sendMessage(from, { delete: mek.key });
                                        await sock.sendMessage(from, { text: '🚫 Bad word detected!' }, { quoted: mek });
                                        continue;
                                    }
                                } catch (e) { console.error('Anti-bad-word check failed:', e.message); }
                            }
                        }
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
