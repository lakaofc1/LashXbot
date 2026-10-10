const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers } = require('@whiskeysockets/baileys');
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
            <title>LashxBot - Pairing Code Generator</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .card { background: #1e293b; padding: 35px; border-radius: 14px; box-shadow: 0 10px 25px rgba(0,0,0,0.6); width: 100%; max-width: 420px; text-align: center; }
                h2 { color: #38bdf8; margin-bottom: 10px; }
                p { color: #94a3b8; font-size: 14px; margin-bottom: 25px; }
                input { width: 100%; padding: 14px; margin: 10px 0; border: 1px solid #475569; border-radius: 8px; background: #0f172a; color: #fff; box-sizing: border-box; font-size: 16px; text-align: center; }
                input:focus { outline: none; border-color: #38bdf8; }
                button { width: 100%; padding: 14px; background: #0284c7; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; margin-top: 15px; font-size: 16px; transition: background 0.2s; }
                button:hover { background: #0369a1; }
                #result { margin-top: 25px; font-size: 16px; color: #cbd5e1; word-break: break-all; }
                .code-box { background: #0f172a; padding: 18px; border-radius: 8px; margin-top: 15px; font-size: 28px; color: #facc15; letter-spacing: 3px; font-weight: bold; border: 2px dashed #38bdf8; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>LashxBot Linker</h2>
                <p>Enter your WhatsApp number with country code (e.g. 94784185833)</p>
                <input type="text" id="phone" placeholder="94784185833">
                <button onclick="getCode()">Get Pairing Code</button>
                <div id="result"></div>
            </div>
            <script>
                async function getCode() {
                    const phone = document.getElementById('phone').value.trim();
                    const resDiv = document.getElementById('result');
                    if(!phone) { alert('Please enter phone number'); return; }
                    resDiv.innerHTML = "Requesting pairing code, please wait...";
                    
                    try {
                        const response = await fetch('/pair', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone })
                        });
                        const data = await response.json();
                        if(data.code) {
                            resDiv.innerHTML = \`Your Pairing Code:<div class="code-box">\${data.code}</div><p style="margin-top:15px;color:#4ade80;">Enter this code in WhatsApp Linked Devices</p>\`;
                        } else {
                            resDiv.innerHTML = "<span style='color:#ef4444;'>Error: " + (data.error || "Failed to generate") + "</span>";
                        }
                    } catch(e) {
                        resDiv.innerHTML = "<span style='color:#ef4444;'>Connection error! Try again.</span>";
                    }
                }
            </script>
        </body>
        </html>
    `);
});

app.post('/pair', async (req, res) => {
    let phoneNumber = req.body.phone?.replace(/\D/g, '');
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Invalid phone number' });
    }

    const sessionDir = path.join(__dirname, 'session');

    // Remove old session directory if exists
    if (fs.existsSync(sessionDir)) {
        try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (e) {
            console.log('Error removing old session:', e.message);
        }
    }

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
        }, 4000);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Pairing server running on port ${PORT}`);
});
