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

        const sessionDir = path.join(__dirname, 'session');
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        // SESSION_ID ekata plain JSON text deela thiyenam creds.json file eka auto create karagannai
        if (config.sessionId && !fs.existsSync(path.join(sessionDir, 'creds.json'))) {
            try {
                let sessData = config.sessionId.trim();
                // Base64 nam decode karai, nathnam plain text widihata save karai
                if (/^[A-Za-z0-9+/=]+$/.test(sessData) && !sessData.startsWith('{')) {
                    sessData = Buffer.from(sessData, 'base64').toString('utf-8');
                }
                fs.writeFileSync(path.join(sessionDir, 'creds.json'), sessData);
                console.log('Session successfully loaded from SESSION_ID!');
            } catch (e) {
                console.error('Failed to load SESSION_ID:', e.message);
            }
        }

        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`Using WA v${version.join('.')}, isLatest:${isLatest}`);

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

                if (phoneNumber && !config.sessionId) {
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
                    console.log('Using session or waiting for connection...');
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
                    console.log('Logged out. Delete session and re-pair.');
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
                    const isFromMe = mek.key.fromMe;
                    const senderJid = isGroup ? (mek.key.participant || from) : from;

                    const messageType = Object.keys(mek.message)[0];
                    let body = '';
                    if (messageType === 'conversation') {
                        body = mek.message.conversation || '';
                    } else if (messageType === 'extendedTextMessage') {
                        body = mek.message.extendedTextMessage?.text || '';
                    } else if (messageType === 'imageMessage' && mek.message.imageMessage?.caption) {
                        body = mek.message.imageMessage.caption;
                    }

                    const pushName = mek.pushName || 'User';
                    await handleCommand(sock, mek, from, body, pushName);
                } catch (err) {
                    console.error('Message processing error:', err.message);
                }
            }
        });

    } catch (err) {
        isStarting = false;
        console.error('Bot Connection Error:', err.message);
        scheduleReconnect(5000);
    }
}

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

connectToWA();
