const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');

async function gcstatus(sock, chatId, m, args) {
    const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted) {
        return sock.sendMessage(chatId, { text: `*❌ Reply to Image / Video / Audio / Text*\n\nExample:\n.gcstatus (reply to image)\n.gcstatus Hello guys (caption ke sath)` }, { quoted: m });
    }

    try {
        const targetMessage = {
            key: {
                remoteJid: chatId,
                id: m.message.extendedTextMessage.contextInfo.stanzaId,
                participant: m.message.extendedTextMessage.contextInfo.participant
            },
            message: quoted
        };

        const type = Object.keys(quoted)[0];
        const text = args.join(" ") || quoted.caption || quoted.text || "";

        let mediaBuffer = null;
        if (type === 'imageMessage' || type === 'videoMessage' || type === 'audioMessage') {
            mediaBuffer = await downloadMediaMessage(targetMessage, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        }

        let statusContent;
        if (mediaBuffer) {
            let mediaType = type.replace('Message', ''); // image, video, audio
            if (mediaType === 'image') {
                statusContent = { image: mediaBuffer, caption: text };
            } else if (mediaType === 'video') {
                statusContent = { video: mediaBuffer, caption: text };
            } else {
                statusContent = { audio: mediaBuffer, mimetype: 'audio/mp4', ptt: true };
            }
        } else {
            statusContent = { text: text };
        }

        await sock.sendMessage("status@broadcast", statusContent, {
            backgroundColor: "#000000",
            font: 2,
            statusJidList: [chatId]
        });

        await sock.sendMessage(chatId, { text: `✅ *STATUS SENT TO GROUP*\n${chatId}` }, { quoted: m });

    } catch (e) {
        console.log(e);
        await sock.sendMessage(chatId, { text: `❌ Failed: ${e.message}` }, { quoted: m });
    }
}

module.exports = gcstatus;
