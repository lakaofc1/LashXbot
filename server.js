const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>LashxBot - Pairing & Connection</title>
            <style>
                body { font-family: Arial, sans-serif; background: #0f172a; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .card { background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); width: 100%; max-width: 400px; text-align: center; }
                h2 { color: #38bdf8; margin-bottom: 20px; }
                input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #475569; border-radius: 6px; background: #0f172a; color: #fff; box-sizing: border-box; }
                button { width: 100%; padding: 12px; background: #0284c7; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; margin-top: 10px; }
                button:hover { background: #0369a1; }
                #result { margin-top: 20px; font-size: 16px; color: #4ade80; word-break: break-all; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>LashxBot Linker</h2>
                <p>Enter your WhatsApp number with country code</p>
                <input type="text" id="phone" placeholder="e.g. 94784185833">
                <button onclick="getCode()">Get Code & Connect</button>
                <div id="result"></div>
            </div>
            <script>
                async function getCode() {
                    const phone = document.getElementById('phone').value;
                    const resDiv = document.getElementById('result');
                    if(!phone) { alert('Please enter phone number'); return; }
                    resDiv.innerHTML = "Generating code and sending to your WhatsApp...";
                    
                    try {
                        const response = await fetch('/pair', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone })
                        });
                        const data = await response.json();
                        if(data.success) {
                            resDiv.innerHTML = "Success! Pairing code has been sent to your WhatsApp number. Check your chats.";
                        } else {
                            resDiv.innerHTML = "Error: " + (data.error || "Failed to process");
                        }
                    } catch(e) {
                        resDiv.innerHTML = "Connection error!";
                    }
                }
            </script>
        </body>
        </html>
    `);
});

app.post('/pair', async (req, res) => {
    const phoneNumber = req.body.phone?.replace(/\D/g, '');
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Invalid phone number' });
    }

    const sessionDir = path.join(__dirname, 'session');

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            browser: Browsers.macOS("Safari"),
            logger: pino({ level: 'fatal' })
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                console.log('✨ LashxBot Connected Successfully via Web Pairing! ✨');
            }
        });

        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                
                const targetJid = phoneNumber + '@s.whatsapp.net';
                await sock.sendMessage(targetJid, { 
                    text: `*✨ LASHXBOT PAIRING CODE ✨*\n\nYour code is: \`\`\`${code}\`\`\`\n\nEnter this code in your Linked Devices to connect your bot.` 
                });

                res.json({ success: true });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }, 3000);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    log(`Server running on port ${PORT}`);
});
