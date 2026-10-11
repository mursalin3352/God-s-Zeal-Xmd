const {
    downloadMediaMessage,
    prepareWAMessageMedia,
    generateWAMessageFromContent
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const WHATSAPP_STATUS_TEXT_LIMIT = 1024;

function splitTextPreservingFormat(input, limit = WHATSAPP_STATUS_TEXT_LIMIT) {
    if (!input) return [];
    const chunks = [];
    let remaining = input;
    while (remaining.length > limit) {
        let splitAt = remaining.lastIndexOf('\n', limit);
        if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', limit);
        if (splitAt <= 0) splitAt = limit;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt);
    }
    if (remaining.length) chunks.push(remaining);
    return chunks;
}

function extractTextFromMessage(content = {}) {
    return (
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        ''
    );
}

function getQuotedMessage(m) {
    // Har type ke message se quoted nikalne ka universal tareeka
    const msg = m.message || {};
    const main = msg.ephemeralMessage?.message || msg.viewOnceMessageV2?.message || msg.viewOnceMessage?.message || msg;

    const contextInfo = main.extendedTextMessage?.contextInfo || main.imageMessage?.contextInfo || main.videoMessage?.contextInfo || main.conversation?.contextInfo || main.contextInfo || {};
    return {
        quotedMessage: contextInfo.quotedMessage || null,
        stanzaId: contextInfo.stanzaId,
        participant: contextInfo.participant,
        contextInfo
    };
}

async function relayGroupStatus(sock, from, payload) {
    const generatedMessage = generateWAMessageFromContent(from, payload, { userJid: sock.user.id });
    await sock.relayMessage(from, generatedMessage.message, { messageId: generatedMessage.key.id });
}

async function gcstatus(sock, chatId, message, inputText) {
    const from = chatId;
    const m = message;
    const reply = (text) => sock.sendMessage(from, { text }, { quoted: m });

    if (!from.endsWith('@g.us')) {
        return reply('❌ This command is for groups only.');
    }

    const { quotedMessage, stanzaId, participant } = getQuotedMessage(m);

    // Input text ko saaf karo -.gcstatus hatado
    let rawText = Array.isArray(inputText)? inputText.join(' ') : String(inputText || '');
    rawText = rawText.replace(/^\.?gcstatus\s*/i, '').trim();

    let targetMessage;
    let rawContent;

    if (quotedMessage) {
        rawContent = quotedMessage.ephemeralMessage?.message || quotedMessage.viewOnceMessageV2?.message || quotedMessage.viewOnceMessage?.message || quotedMessage;
        targetMessage = {
            key: { remoteJid: from, id: stanzaId, participant: participant },
            message: quotedMessage
        };
    } else {
        rawContent = m.message?.ephemeralMessage?.message || m.message?.viewOnceMessageV2?.message || m.message || {};
        rawContent = rawContent.extendedTextMessage || rawContent.imageMessage || rawContent.videoMessage || rawContent.conversation? rawContent : rawContent;
        // Agar direct media caption pe.gcstatus likha hai
        if (m.message?.imageMessage || m.message?.videoMessage) {
            rawContent = m.message;
            targetMessage = m;
        } else {
            targetMessage = m;
            rawContent = m.message || {};
        }
    }

    const content = rawContent.ephemeralMessage?.message || rawContent.viewOnceMessageV2?.message || rawContent.viewOnceMessage?.message || rawContent;

    const actualContent = content.imageMessage? content : (content.extendedTextMessage? content : content);

    const isImage =!!(actualContent.imageMessage || content.imageMessage);
    const isVideo =!!(actualContent.videoMessage || content.videoMessage);
    const isAudio =!!(actualContent.audioMessage || content.audioMessage || actualContent.pttMessage);

    let mediaContent = content.imageMessage? content : actualContent;
    if (content.imageMessage || content.videoMessage || content.audioMessage) mediaContent = content;
    else if (actualContent.imageMessage || actualContent.videoMessage) mediaContent = actualContent;

    const finalMediaObj = mediaContent.imageMessage? mediaContent : (mediaContent.imageMessage? mediaContent : mediaContent);

    // Caption / fallback
    let fallbackText = '';
    const mediaCheck = finalMediaObj.imageMessage || finalMediaObj.videoMessage? finalMediaObj : content;
    if (mediaCheck.imageMessage) fallbackText = mediaCheck.imageMessage.caption || '';
    else if (mediaCheck.videoMessage) fallbackText = mediaCheck.videoMessage.caption || '';
    else fallbackText = extractTextFromMessage(content);

    let statusText = rawText || fallbackText;

    // Agar abhi bhi.gcstatus hi hai to khali kar do
    if (statusText.trim().toLowerCase() === '.gcstatus' || statusText.toLowerCase().startsWith('.gcstatus')) {
        statusText = statusText.replace(/^\.?gcstatus\s*/i, '').trim();
    }

    const hasMedia = isImage || isVideo || isAudio || (quotedMessage && (quotedMessage.imageMessage || quotedMessage.videoMessage || quotedMessage.audioMessage || quotedMessage.viewOnceMessageV2?.message?.imageMessage));

    if (!hasMedia &&!statusText) {
        return reply(`*Usage:*\n•.gcstatus Hello group\n•.gcstatus (as caption on media)\n•.gcstatus (reply to image/video/audio)`);
    }

    await sock.sendMessage(from, { react: { text: '⏳', key: m.key } });

    try {
        // Agar quoted me media hai to usko use karo
        let useMedia = hasMedia;
        let downloadTarget = targetMessage;
        let finalContent = content;

        if (quotedMessage) {
            const qInner = quotedMessage.viewOnceMessageV2?.message || quotedMessage.viewOnceMessage?.message || quotedMessage.ephemeralMessage?.message || quotedMessage;
            if (qInner.imageMessage || qInner.videoMessage || qInner.audioMessage) {
                finalContent = qInner;
                useMedia = true;
            }
        } else {
            const mInner = m.message?.viewOnceMessageV2?.message || m.message?.ephemeralMessage?.message || m.message;
            if (mInner?.imageMessage || mInner?.videoMessage) {
                finalContent = mInner;
                useMedia = true;
            }
        }

        if (useMedia) {
            const mediaBuffer = await downloadMediaMessage(downloadTarget, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
            const textParts = splitTextPreservingFormat(statusText, WHATSAPP_STATUS_TEXT_LIMIT);
            const captions = textParts.length? textParts : [statusText || undefined];

            for (const caption of captions) {
                let mediaOptions = {};
                if (finalContent.imageMessage) mediaOptions = { image: mediaBuffer, caption };
                else if (finalContent.videoMessage) mediaOptions = { video: mediaBuffer, caption };
                else mediaOptions = { audio: mediaBuffer, mimetype: finalContent.audioMessage?.mimetype || 'audio/mp4' };

                const preparedMedia = await prepareWAMessageMedia(mediaOptions, { upload: sock.wsUploadToServer });
                let finalMediaMessage = {};
                if (finalContent.imageMessage) finalMediaMessage = { imageMessage: preparedMedia.imageMessage };
                else if (finalContent.videoMessage) finalMediaMessage = { videoMessage: preparedMedia.videoMessage };
                else finalMediaMessage = { audioMessage: preparedMedia.audioMessage };

                await relayGroupStatus(sock, from, { groupStatusMessageV2: { message: finalMediaMessage } });
            }
        } else {
            const textParts = splitTextPreservingFormat(statusText, WHATSAPP_STATUS_TEXT_LIMIT);
            const parts = textParts.length? textParts : [statusText];
            for (const part of parts) {
                const randomHex = Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
                await relayGroupStatus(sock, from, {
                    groupStatusMessageV2: {
                        message: {
                            extendedTextMessage: {
                                text: part,
                                backgroundArgb: 0xFF000000 + parseInt(randomHex, 16),
                                font: 2
                            }
                        }
                    }
                });
            }
        }
        await sock.sendMessage(from, { react: { text: '✅', key: m.key } });
    } catch (error) {
        console.error('[GCSTATUS] error:', error);
        await sock.sendMessage(from, { react: { text: '❌', key: m.key } });
        return reply(`❌ Failed to post group status.\n${error.message}`);
    }
}

module.exports = gcstatus;
