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
            <title>LashxBot - Pairing Code</title>
            <style>
                body { font-family: Arial, sans-serif; background: #0f172a; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .card { background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); width: 100%; max-width: 400px; text-align: center; }
                h2 { color: #38bdf8; margin-bottom: 20px; }
                input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #475569; border-radius: 6px; background: #0f172a; color: #fff; box-sizing: border-box; }
                button { width: 100%; padding: 12px; background: #0284c7; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; margin-top: 10px; }
                button:hover { background: #0369a1; }
                #result { margin-top: 20px; font-size: 18px; color: #4ade80; word-break: break-all; }
                .code-box { background: #0f172a; padding: 15px; border-radius: 8px; margin-top: 15px; font-size: 24px; color: #facc15; letter-spacing: 2px; font-weight: bold; border: 1px dashed #38bdf8; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>LashxBot Pairing</h2>
                <p>Enter your WhatsApp number with country code</p>
                <input type="text" id="phone" placeholder="e.g. 94784185833">
                <button onclick="getCode()">Get Pairing Code</button>
                <div id="result"></div>
            </div>
            <script>
                async function getCode() {
                    const phone = document.getElementById('phone').value;
                    const resDiv = document.getElementById('result');
                    if(!phone) { alert('Please enter phone number'); return; }
                    resDiv.innerHTML = "Generating code, please wait...";
                    
                    try {
                        const response = await fetch('/pair', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone })
                        });
                        const data = await response.json();
                        if(data.code) {
                            resDiv.innerHTML = \`Your Pairing Code:<div class="code-box">\${data.code}</div>\`;
                        } else {
                            resDiv.innerHTML = "Error: " + (data.error || "Failed to generate");
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

    const sessionId = 'temp_' + Date.now();
    const sessionDir = path.join(__dirname, 'sessions', sessionId);

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

        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                res.json({ code });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }, 5000);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
