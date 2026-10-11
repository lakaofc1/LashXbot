const config = require('./config');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');
const { S_WHATSAPP_NET, jidNormalizedUser, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { saveBotSettings } = require('./mongodb-auth');

async function handleCommand(sock, mek, from, body, pushName) {
    const isGroup = from.endsWith('@g.us');
    const senderJid = isGroup ? (mek.key.participant || from) : from;
    const isFromMe = mek.key.fromMe;

    let isOwner = isFromMe;
    if (!isOwner && senderJid) {
        isOwner = config.ownerNumber.some(num => senderJid.includes(num));
    }

    if (!isOwner) {
        if (config.workMode === 'private') return;
        if (config.workMode === 'inbox' && isGroup) return;
        if (config.workMode === 'group' && !isGroup) return;
    }

    if (!body.startsWith(config.prefix)) return;

    const args = body.slice(config.prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const q = args.join(' ');

    const sendReply = async (text) => {
        await sock.sendMessage(from, { text: text }, { quoted: mek });
    };

    const quoted = mek.message?.extendedTextMessage?.contextInfo?.quotedMessage ? {
        sender: mek.message.extendedTextMessage.contextInfo.participant,
        message: mek.message.extendedTextMessage.contextInfo.quotedMessage,
        download: async () => {
            try {
                return await downloadMediaMessage({ key: mek.key, message: mek.message.extendedTextMessage.contextInfo.quotedMessage }, 'buffer', {}, { logger: sock.logger });
            } catch {
                return null;
            }
        }
    } : null;

    let groupMetadata = null;
    let groupAdmins = [];
    let isAdmins = false;
    let isBotAdmins = false;

    if (isGroup) {
        try {
            groupMetadata = await sock.groupMetadata(from);
            const participants = groupMetadata.participants || [];
            groupAdmins = participants.filter(p => p.admin).map(p => p.id);
            isAdmins = groupAdmins.includes(senderJid);
            isBotAdmins = groupAdmins.includes(sock.user.id.split(':')[0] + '@s.whatsapp.net');
        } catch (e) {}
    }

    switch (command) {
        case 'ping':
            const pingText = `┏ ◦ *⚡ PING SPEED*
┃ 
┃ 🚀 *Status:* Online & Active!
┃ 🏓 *Response:* Ultra Fast (< 0.05s)
┃ 👑 *User:* ${pushName} ${isOwner ? '(Owner ✨)' : ''}
┃ 📍 *Chat:* ${isGroup ? 'Group Chat' : 'Private Chat'}
┃
┗ ────────────────── ✦`;
            await sendReply(pingText);
            break;

        case 'menu':
        case 'help':
            const menuText = `╭━━━ ✨ *${config.botName.toUpperCase()} ULTIMATE PANEL* 🥰 ━━━╮
┃
┃ 👋 Hello *${pushName}*,
┃ Here is your complete command list!
┃
┣━━ 📂 *GENERAL COMMANDS*
┃ ⚙️ \`${config.prefix}settings\` - View bot settings\n┃ ⚙️ \`${config.prefix}setfeature\` - Toggle features (owner)\n┃ ⚡ \`${config.prefix}ping\` - Check bot speed
┃ 👤 \`${config.prefix}owner\` - View owner details
┃ 👁️ \`${config.prefix}vv\` - Download view once
┃
┣━━ 👑 *OWNER & PROFILE TOOLS*
┃ 🖼️ \`${config.prefix}setfulpp\` - Set full DP
┃ 🖼️ \`${config.prefix}setgrouppp\` - Set group DP
┃ ℹ️ \`${config.prefix}ginfo\` - Group info
┃ 🔑 \`${config.prefix}getdp\` - Get user DP
┃ 📢 \`${config.prefix}msgall\` - Message all group members
┃ 📢 \`${config.prefix}broadcast\` - Broadcast to groups
┃ 🔥 \`${config.prefix}boom\` - Spam messages
┃
┣━━ 👥 *GROUP MANAGEMENT*
┃ 🔕 \`${config.prefix}hidetag\` - Hide tag message
┃
${isOwner ? `┣━━ 👑 *SYSTEM CONTROLS*
┃ 🔄 \`${config.prefix}restart\` - Restart bot instantly
┃ 🛑 \`${config.prefix}shutdown\` - Turn off bot process
┃ 🛠️ \`${config.prefix}setmode <public/private>\` - Change mode
┃` : ''}
┣━━━━━━━━━━━━━━━━━━━━━━━⡱
┃ 🌟 *Prefix:* [ ${config.prefix} ]
┃ 👑 *Mode:* ${config.workMode.toUpperCase()}
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;

            await sock.sendMessage(from, {
                image: { url: 'https://i.ibb.co/6RqqZ5hg/file-000000005b908207bb180ce30137e11d.png' },
                caption: menuText
            }, { quoted: mek });
            break;

        case 'owner':
            await sendReply(`👑 *Owner Information*\n\n🏷️ Name: ${config.ownerName}\n🤖 Bot: ${config.botName}\n📞 Contact: wa.me/${config.ownerNumber[0]}`);
            break;

        case 'setfulpp':
        case 'dp':
        case 'setdp':
        case 'setpp':
        case 'fulpp':
            if (!isOwner) return await sendReply("You are not the bot's owner! 🚫");
            if (!quoted) return sendReply("Please provide an image by quoting it to set as your profile picture");
            try {
                let imageBuffer = await quoted.download();
                if (!imageBuffer) return sendReply("Please provide a valid image!");

                const image = await Jimp.read(imageBuffer);
                image.scaleToFit({ w: 720, h: 720 });
                const finalImageBuffer = await image.getBuffer('image/jpeg');

                await sock.query({
                    tag: 'iq',
                    attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:picture' },
                    content: [{ tag: 'picture', attrs: { type: 'image' }, content: finalImageBuffer }]
                });
                await sendReply("Your profile picture has been updated ✔️.");
            } catch (error) {
                await sendReply(`Error: ${error.message}`);
            }
            break;

        case 'setgrouppp':
        case 'groupdp':
        case 'setgroupdp':
        case 'grouppp':
            if (!isGroup) return sendReply("🚫 *This command can only be used in groups.*");
            if (!isOwner && !isAdmins) return sendReply("🚫 *Only the group owner or an admin can use this.*");
            if (!quoted) return sendReply("Please provide an image by quoting it to set as the group profile picture.");
            try {
                let imageBuffer = await quoted.download();
                if (!imageBuffer) return sendReply("Please provide a valid image!");

                const image = await Jimp.read(imageBuffer);
                image.scaleToFit({ w: 720, h: 720 });
                const finalImageBuffer = await image.getBuffer('image/jpeg');

                await sock.query({
                    tag: 'iq',
                    attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:picture', target: jidNormalizedUser(from) },
                    content: [{ tag: 'picture', attrs: { type: 'image' }, content: finalImageBuffer }]
                });
                await sendReply("Group profile picture has been updated successfully! ✔️");
            } catch (error) {
                await sendReply(`Error: ${error.message}`);
            }
            break;

        case 'vv':
        case 'dvv':
            try {
                const quotedMsg = mek.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quotedMsg) return sendReply("```Please reply to a ViewOnce message!```");

                const viewOnceMsg = quotedMsg.imageMessage?.viewOnce ? quotedMsg.imageMessage :
                                    quotedMsg.videoMessage?.viewOnce ? quotedMsg.videoMessage :
                                    quotedMsg.audioMessage?.viewOnce ? quotedMsg.audioMessage :
                                    quotedMsg.viewOnceMessageV2?.message?.imageMessage ||
                                    quotedMsg.viewOnceMessageV2?.message?.videoMessage ||
                                    quotedMsg.viewOnceMessageV2Extension?.message?.audioMessage;

                if (!viewOnceMsg) return sendReply("```This is not a ViewOnce message!```");

                let mediaBuffer = await downloadMediaMessage({ key: mek.key, message: quotedMsg }, 'buffer', {}, { logger: sock.logger });
                let caption = viewOnceMsg.caption || "";

                if (viewOnceMsg.mimetype?.includes('image') || quotedMsg.imageMessage || quotedMsg.viewOnceMessageV2?.message?.imageMessage) {
                    await sock.sendMessage(from, { image: mediaBuffer, caption: caption }, { quoted: mek });
                } else if (viewOnceMsg.mimetype?.includes('video') || quotedMsg.videoMessage || quotedMsg.viewOnceMessageV2?.message?.videoMessage) {
                    await sock.sendMessage(from, { video: mediaBuffer, caption: caption }, { quoted: mek });
                } else if (viewOnceMsg.mimetype?.includes('audio') || quotedMsg.audioMessage) {
                    await sock.sendMessage(from, { audio: mediaBuffer, mimetype: viewOnceMsg.mimetype, ptt: true }, { quoted: mek });
                }
            } catch (e) {
                await sendReply("```Error downloading view once message!```");
            }
            break;

        case 'ginfo':
            if (!isOwner) return sendReply("*Owner Only ❌*");
            try {
                const groupJid = args[0] || from;
                if (!groupJid.includes("@g.us")) return sendReply("Invalid group JID.");
                const metadata = await sock.groupMetadata(groupJid);
                const { subject, desc, id, participants, creation, restrict, announce, ephemeralDuration } = metadata;
                let ppUrl = "No profile picture found";
                try { ppUrl = await sock.profilePictureUrl(id, 'image'); } catch {}

                const creationDate = new Date(creation * 1000).toLocaleString();
                const admins = participants.filter(p => p.admin).map(p => `@${p.id.split('@')[0]}`);
                const adminList = admins.length > 0 ? admins.join(', ') : 'No admins found';

                const groupInfoText = `*Group Info:*

📌 *Name:* ${subject}
🆔 *Group ID:* ${id}
👥 *Members:* ${participants.length}
👑 *Admins:* ${adminList}
📅 *Created On:* ${creationDate}
🔒 *Restricted:* ${restrict ? "Yes" : "No"}
📢 *Announcement Only:* ${announce ? "Yes" : "No"}
⏳ *Disappearing Messages:* ${ephemeralDuration ? `${ephemeralDuration / 3600} hours` : "Off"}
📜 *Description:* ${desc ? desc : 'No description available'}

> © ᴘᴏᴡᴇʀᴇᴅ ʙʏ ʟᴀꜱʜ𝕏ʙᴏᴛ`;

                if (ppUrl !== "No profile picture found") {
                    await sock.sendMessage(from, { image: { url: ppUrl }, caption: groupInfoText }, { quoted: mek });
                } else {
                    sendReply(groupInfoText);
                }
            } catch (e) {
                sendReply("*ERROR..!* Could not retrieve group info.");
            }
            break;

        case 'getdp':
        case 'getpp':
        case 'ppurl':
        case 'getgp':
        case 'getprofile':
            if (!isOwner) return sendReply("*Owner Only ❌*");
            try {
                let targetId = quoted ? quoted.sender : mek.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                if (!targetId && args[0]) {
                    let num = args[0].replace(/[^0-9]/g, "");
                    if (num.length > 5) targetId = num + "@s.whatsapp.net";
                }
                if (!targetId) targetId = from;

                let ppUrl = "No profile picture found";
                try { ppUrl = await sock.profilePictureUrl(targetId, 'image'); } catch {}

                const caption = `Profile Picture of:\n*${targetId}*\n\n> *𝗣 𝗢 𝗪 𝗘 𝗥 𝗘 🇩  🇧 🇾   🇱 🇦 🇸 🇭 🇽 🇧 🇴 🇹*`;
                if (ppUrl !== "No profile picture found") {
                    await sock.sendMessage(from, { image: { url: ppUrl }, caption }, { quoted: mek });
                } else {
                    sendReply(caption + "\n\n*No profile picture found.*");
                }
            } catch (e) {
                sendReply("*ERROR..!*");
            }
            break;

        case 'msgall':
        case 'messageall':
            if (!isGroup) return sendReply("❌ This command can only be used in groups!");
            if (!isOwner) return sendReply("❌ You Are Not The Owner!");
            if (!q) return sendReply("❌ Please provide a message to send!");
            try {
                const participants = groupMetadata?.participants || [];
                sendReply(`📢 Sending messages to ${participants.length} members...`);
                await Promise.all(participants.map(async (p) => {
                    const userId = p.id || p.jid;
                    if (userId) {
                        try { await sock.sendMessage(userId, { text: q }); } catch (err) {}
                    }
                }));
                sendReply("✅ Messages have been sent successfully!");
            } catch (error) {
                sendReply("❌ Error: " + error.message);
            }
            break;

        case 'boom':
            if (!isOwner) return sendReply("❌ This command is restricted to the owner only.");
            try {
                const count = Math.min(parseInt(args[0]) || 10, 100);
                const customText = args.slice(1).join(" ") || "Boom!";
                await Promise.all(Array.from({ length: count }, () => sock.sendMessage(from, { text: customText })));
                sendReply(`✅ Sent ${count} messages.`);
            } catch (error) {
                sendReply(`❌ Error: ${error.message}`);
            }
            break;

        case 'broadcast':
            if (!isOwner) return sendReply("❌ You are not the owner!");
            if (!q) return sendReply("📢 Please provide a message to broadcast.");
            try {
                const groupIds = Object.keys(await sock.groupFetchAllParticipating());
                for (const groupId of groupIds) {
                    await sock.sendMessage(groupId, { text: q }, { quoted: mek });
                }
                sendReply("📢 Message broadcasted to all groups.");
            } catch (error) {
                sendReply("❌ Error broadcasting message.");
            }
            break;

        case 'hidetag':
            if (!isGroup) return sendReply("❌ This command can only be used in groups!");
            if (!q) return sendReply("❌ Please provide a message to hidetag!");
            try {
                const metadata = await sock.groupMetadata(from);
                const mentions = metadata.participants.map(m => m.id);
                const hidetagText = `╭━━━ 📢 *ANNOUNCEMENT* ━━━╮\n┃\n┃ ${q}\n┃\n╰━━━━━━━━━━━━━━━━━━━━╯`;
                await sock.sendMessage(from, { text: hidetagText, mentions: mentions });
            } catch (e) {
                await sendReply("❌ Error executing hidetag command!");
            }
            break;

        case 'settings':
        case 'botsettings':
            if (!isOwner) return sendReply('❌ Owner command only.');
            await sendReply(`⚙️ *LASHX BOT SETTINGS*\n\n` +
                `Mode: ${config.workMode}\nAnti-delete: ${config.antiDelete ? 'ON' : 'OFF'} (${config.ANTI_DELETE})\n` +
                `Auto-read: ${config.autoRead ? 'ON' : 'OFF'}\nAuto-status-view: ${config.autoStatusView ? 'ON' : 'OFF'}\n` +
                `Always-online: ${config.alwaysOnline ? 'ON' : 'OFF'}\nAuto-typing: ${config.autoTyping ? 'ON' : 'OFF'}\nAuto-recording: ${config.autoRecording ? 'ON' : 'OFF'}\n\n` +
                `Commands: ${config.prefix}setfeature antidelete on/off\n` +
                `${config.prefix}setfeature autoread on/off\n${config.prefix}setfeature statusview on/off\n` +
                `${config.prefix}setfeature online on/off\n${config.prefix}setfeature typing on/off\n` +
                `${config.prefix}setfeature recording on/off\n${config.prefix}setfeature antilink on/off\n${config.prefix}setfeature antibad on/off\n${config.prefix}setfeature antidelete-mode group/inbox/group&inbox/off\n` +
                `${config.prefix}setmode public/private/inbox/group`);
            break;

        case 'setfeature':
            if (!isOwner) return sendReply('❌ Owner command only.');
            {
                const feature = (args[0] || '').toLowerCase();
                const value = (args[1] || '').toLowerCase();
                const bool = value === 'on' ? true : value === 'off' ? false : null;
                if (feature === 'antidelete-mode') {
                    if (!['group', 'inbox', 'group&inbox', 'off'].includes(value)) return sendReply(`Use: ${config.prefix}setfeature antidelete-mode group|inbox|group&inbox|off`);
                    config.ANTI_DELETE = value;
                    config.antiDelete = value !== 'off';
                } else {
                    const fields = { antidelete: 'antiDelete', autoread: 'autoRead', statusview: 'autoStatusView', online: 'alwaysOnline', typing: 'autoTyping', recording: 'autoRecording' };
                    if (!fields[feature] || bool === null) return sendReply(`Usage: ${config.prefix}setfeature antidelete|autoread|statusview|online|typing|recording on|off`);
                    config[fields[feature]] = bool;
                    if (feature === 'antidelete') config.ANTI_DELETE = bool ? 'group&inbox' : 'off';
                }
                try { await saveBotSettings(config); } catch (e) { console.error('Saving settings failed:', e.message); return sendReply('⚠️ Setting changed for now, but MongoDB save failed. Check Heroku logs.'); }
                return sendReply(`✅ ${feature} updated to *${value.toUpperCase()}* and saved to MongoDB. It will remain after a Heroku restart.`);
            }

        case 'setmode':
            if (!isOwner) return sendReply("❌ Owner command only!");
            if (!q || !['public', 'private', 'inbox', 'group'].includes(q.toLowerCase())) {
                return sendReply(`❌ Invalid mode! Use:\n${config.prefix}setmode public\n${config.prefix}setmode private`);
            }
            config.workMode = q.toLowerCase();
            try { await saveBotSettings(config); } catch (e) { console.error('Saving settings failed:', e.message); }
            await sendReply(`✅ Bot work mode successfully changed to: *${config.workMode.toUpperCase()}* and saved to MongoDB.`);
            break;

        case 'restart':
            if (!isOwner) return sendReply("❌ Owner command only!");
            try {
                const { exec } = require("child_process");
                await sendReply("🔄 Restarting LashxBot now...");
                setTimeout(() => {
                    exec("pm2 restart all", (error) => {
                        if (error) process.exit(0);
                    });
                }, 1000);
            } catch (e) {
                process.exit(0);
            }
            break;

        case 'shutdown':
            if (!isOwner) return sendReply("❌ Owner command only!");
            await sendReply("🛑 Shutting down LashxBot completely. Goodbye!");
            setTimeout(() => process.exit(1), 1000);
            break;

        default:
            break;
    }
}

module.exports = { handleCommand };
