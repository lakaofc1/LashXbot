const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    jidNormalizedUser,
    Browsers
} = require('@whiskeysockets/baileys');

const { handleCommand } = require('./commands');
const config = require('./config');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { useMongoDBAuthState, resetMongoDBAuthState, loadBotSettings } = require('./mongodb-auth');
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


// ---------- Auto View Once -> normal media ----------
const processedViewOnce = new Set();

function getViewOnceInfo(message) {
    let current = message || {};
    let wrapped = false;

    for (let i = 0; i < 6; i++) {
        if (current.viewOnceMessage || current.viewOnceMessageV2 || current.viewOnceMessageV2Extension) wrapped = true;
        const next = current.ephemeralMessage?.message ||
            current.viewOnceMessage?.message ||
            current.viewOnceMessageV2?.message ||
            current.viewOnceMessageV2Extension?.message ||
            current.documentWithCaptionMessage?.message;
        if (!next) break;
        current = next;
    }

    for (const type of ['imageMessage', 'videoMessage', 'audioMessage']) {
        const media = current[type];
        if (media && (wrapped || media.viewOnce === true)) {
            return { type, media, content: current };
        }
    }
    return null;
}


function getViewOnceTarget(sock) {
    if (config.VIEWONCE_SEND_TO) return String(config.VIEWONCE_SEND_TO).replace(/\D/g, '') + '@s.whatsapp.net';
    return jidNormalizedUser(sock.user?.id || '');
}

function getMsgTimestamp(mek) {
    const t = mek.messageTimestamp;
    if (typeof t === 'number') return t;
    if (t && typeof t.toNumber === 'function') return t.toNumber();
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
}

async function forwardViewOnce(sock, mek, from, isGroup) {
    const info = getViewOnceInfo(mek.message);
    const rawKeys = Object.keys(mek.message || {}).filter((k) => k !== 'messageContextInfo');
    const hasVOText = /viewonce/i.test(JSON.stringify(mek.message || {}).slice(0, 20000));
    const isPlainText = rawKeys.every((k) => ['conversation', 'extendedTextMessage', 'reactionMessage', 'senderKeyDistributionMessage'].includes(k));

    // In-chat diagnostics (.vodebug on)
    if (config.voDebug && !isPlainText) {
        await sock.sendMessage(getViewOnceTarget(sock), {
            text: `🧪 *VO DEBUG*\nkeys: ${rawKeys.join(', ')}\nprotocolType: ${mek.message?.protocolMessage?.type ?? '-'}\nviewOnce text found: ${hasVOText}\ndetected: ${info ? info.type : 'NO'}\nchat: ${from}`
        });
    }

    if (!info) {
        if (hasVOText) {
            console.log('[VO] viewOnce text present but media not recognised. keys:', rawKeys.join(','));
            await sock.sendMessage(getViewOnceTarget(sock), {
                text: `⚠️ View Once message ekak awa, namuth type eka therunne naha.\nkeys: ${rawKeys.join(', ')}\nMe message eka mata yawanna.`
            });
        }
        return;
    }
    console.log('[VO] View Once detected:', info.type);

    const msgId = mek.key.id;
    if (msgId) {
        if (processedViewOnce.has(msgId)) return;
        processedViewOnce.add(msgId);
        if (processedViewOnce.size > 500) processedViewOnce.delete(processedViewOnce.values().next().value);
    }

    const target = getViewOnceTarget(sock);

    const senderJid = isGroup ? (mek.key.participant || from) : from;
    const senderNumber = (senderJid || '').replace(/@.*/, '');
    const time = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' });

    const details =
        `👁️ *View Once Recovered*\n\n` +
        `👤 *From:* ${mek.pushName || 'Unknown'} (+${senderNumber})\n` +
        `💬 *Chat:* ${isGroup ? 'Group (' + from.replace(/@.*/, '') + ')' : 'Private'}\n` +
        `🕒 *Time:* ${time}` +
        (info.media.caption ? `\n\n📝 ${info.media.caption}` : '');

    const buffer = await downloadMediaMessage(
        { key: mek.key, message: info.content },
        'buffer',
        {},
        { logger, reuploadRequest: sock.updateMediaMessage }
    );

    // NOTE: no `viewOnce: true` here, so it is sent as a NORMAL message
    if (info.type === 'imageMessage') {
        await sock.sendMessage(target, { image: buffer, caption: details });
    } else if (info.type === 'videoMessage') {
        await sock.sendMessage(target, {
            video: buffer,
            caption: details,
            mimetype: info.media.mimetype || 'video/mp4'
        });
    } else {
        await sock.sendMessage(target, { text: details });
        await sock.sendMessage(target, {
            audio: buffer,
            mimetype: info.media.mimetype || 'audio/ogg; codecs=opus',
            ptt: !!info.media.ptt
        });
    }
    console.log(`View Once forwarded from +${senderNumber}`);
}


async function connectToWA() {
    if (isStarting || isShuttingDown) return;
    isStarting = true;

    try {
        console.log(`Connecting ${config.botName} WhatsApp Bot...`);

        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`Using WA v${version.join('.')}, isLatest:${isLatest}`);

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
                    console.log('Logged out (401). Clearing only WhatsApp authentication data in MongoDB...');
                    try {
                        await resetMongoDBAuthState();
                        pairingPromptHandled = false;
                        console.log('WhatsApp auth data cleared. A fresh pairing code will be requested on reconnect.');
                        scheduleReconnect(2500);
                    } catch (resetErr) {
                        console.error('Could not clear WhatsApp auth data:', resetErr.message);
                        console.error('Fix MongoDB access and restart the worker to try again.');
                    }
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
                    if (config.voDebug && mek.key?.remoteJid && !mek.key.fromMe && mek.key.remoteJid !== 'status@broadcast' && (!mek.message || mek.messageStubType)) {
                        try {
                            await sock.sendMessage(getViewOnceTarget(sock), {
                                text: `🧪 *VO DEBUG (empty/stub)*\nmessage: ${mek.message ? 'present' : 'MISSING'}\nstubType: ${mek.messageStubType ?? '-'}\nstubParams: ${JSON.stringify(mek.messageStubParameters || []).slice(0, 300)}\nupsertType: ${chatUpdate.type}\nchat: ${mek.key.remoteJid}`
                            });
                        } catch (_) {}
                    }

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

                    if (config.ANTI_DELETE !== 'off') {
                            const baseDir = 'message_data';
                            await fs.promises.mkdir(baseDir, { recursive: true });

                            async function loadChatData(remoteJid, messageId) {
                                const chatFilePath = path.join(baseDir, remoteJid, `${messageId}.json`);
                                try {
                                    return JSON.parse(await fs.promises.readFile(chatFilePath, 'utf8')) || [];
                                } catch (_) {
                                    return [];
                                }
                            }

                            async function saveChatData(remoteJid, messageId, chatData) {
                                const chatDir = path.join(baseDir, remoteJid);
                                await fs.promises.mkdir(chatDir, { recursive: true });
                                await fs.promises.writeFile(path.join(chatDir, `${messageId}.json`), JSON.stringify(chatData));
                            }

                            async function handleIncomingMessage(message) {
                                if (!message.key?.id) return;
                                const chatData = await loadChatData(from, message.key.id);
                                chatData.push(message);
                                await saveChatData(from, message.key.id, chatData);
                            }

                            const delfrom = config.DELETEMSGSENDTO !== '' ? config.DELETEMSGSENDTO + '@s.whatsapp.net' : from;

                            async function handleMessageRevocation(revocationMessage) {
                                const messageId = revocationMessage.message.protocolMessage.key.id;
                                const originalMessage = (await loadChatData(from, messageId))[0];
                                if (!originalMessage) return;

                                if (originalMessage.key?.fromMe === true) {
                                    console.log("Anti-delete: ignored deletion of the bot own message.");
                                    return;
                                }

                                const deletedByJid = revocationMessage.key.participant || revocationMessage.key.remoteJid;
                                const sentByJid = originalMessage.key.fromMe ? (sock.user?.id || originalMessage.key.participant || originalMessage.key.remoteJid) : (originalMessage.key.participant || originalMessage.key.remoteJid);
                                const deletedByNumber = (deletedByJid || '').replace(/@.*/, '');
                                const sentByNumber = (sentByJid || '').replace(/@.*/, '');

                                const sriLankaDateTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' });

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

                                        // For media types that cannot carry a caption (especially stickers and audio),
                                        // send the delete details as a separate reply to the recovered media.
                                        if (resentMessage && (original.stickerMessage || original.audioMessage || original.contactMessage || original.locationMessage || original.liveLocationMessage)) {
                                            const replyLabel = original.stickerMessage ? 'Sticker' : original.audioMessage ? 'Audio' : original.contactMessage ? 'Contact' : 'Location';
                                            await conn.sendMessage(delfrom, {
                                                text: `*🚫 This ${replyLabel} Message was deleted !!*\n\n${deleteInfo}${textBlock}`,
                                                mentions
                                            }, { quoted: resentMessage });
                                        }

                                    } catch (mediaErr) {
                                        console.error('Anti-delete media recovery failed:', mediaErr.message);

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
                                    await handleIncomingMessage(mek);
                                }
                            }
                    }

                    const msgTs = getMsgTimestamp(mek);
                    const msgAge = msgTs ? Math.abs(Date.now() / 1000 - msgTs) : 0;
                    if (config.autoViewOnce && !isFromMe && from !== 'status@broadcast' && msgAge < 300) {
                        try {
                            await forwardViewOnce(sock, mek, from, isGroup);
                        } catch (voErr) {
                            console.error('Auto View Once failed:', voErr.stack || voErr.message);
                            try {
                                await sock.sendMessage(getViewOnceTarget(sock), { text: `⚠️ View Once message ekak awa, namuth recover karanna beri una.\nReason: ${voErr.message}` });
                            } catch (_) {}
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

                    if (config.autoTyping) {
                        await sock.sendPresenceUpdate('composing', from);
                    } else if (config.autoRecording) {
                        await sock.sendPresenceUpdate('recording', from);
                    }

                    const body = getTextFromMessage(mek.message);

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
