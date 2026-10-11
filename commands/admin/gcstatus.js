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
    return content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || '';
}

function getQuotedMessage(m) {
    const msg = m.message || {};
    const main = msg.ephemeralMessage?.message || msg.viewOnceMessageV2?.message || msg.viewOnceMessage?.message || msg;
    const contextInfo = main.extendedTextMessage?.contextInfo || main.imageMessage?.contextInfo || main.videoMessage?.contextInfo || main.contextInfo || {};
    return { quotedMessage: contextInfo.quotedMessage || null, stanzaId: contextInfo.stanzaId, participant: contextInfo.participant };
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
    let args = Array.isArray(inputText)? inputText : String(inputText || '').trim().split(/ +/);
    if (args.length === 1 && args[0] === '') args = [];

    //.gcstatus ko args se hatao
    if (args[0]?.toLowerCase().startsWith('.gcstatus') || args[0]?.toLowerCase().startsWith('gcstatus')) {
        args.shift();
    }
    let rawArgsText = args.join(' ').replace(/^\.?gcstatus\s*/i, '').trim();

    // Target group ka pata lagao (link / jid / current)
    let targetGroupJid = from;
    let statusText = rawArgsText;
    let linkMatch = rawArgsText.match(/https?:\/\/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
    let jidMatch = rawArgsText.match(/([0-9]+@g\.us)/);

    if (linkMatch) {
        const inviteCode = linkMatch[1];
        statusText = statusText.replace(linkMatch[0], '').trim();
        try {
            // Link se group JID nikalo
            const groupInfo = await sock.groupGetInviteInfo(inviteCode).catch(() => null);
            if (groupInfo && groupInfo.id) {
                targetGroupJid = groupInfo.id;
            } else {
                // Agar bot pehle se us group me nahi to join karne ki koshish
                const joinedId = await sock.groupAcceptInvite(inviteCode).catch(() => null);
                if (joinedId) targetGroupJid = joinedId;
            }
        } catch {}
    } else if (jidMatch) {
        targetGroupJid = jidMatch[1];
        statusText = statusText.replace(jidMatch[0], '').trim();
    }

    // Quoted media
    let targetMessage = null;
    let rawQuotedContent = null;
    if (quotedMessage) {
        rawQuotedContent = quotedMessage.ephemeralMessage?.message || quotedMessage.viewOnceMessageV2?.message || quotedMessage;
        targetMessage = { key: { remoteJid: targetGroupJid, id: stanzaId, participant }, message: quotedMessage };
    }

    const contentToCheck = rawQuotedContent || m.message || {};
    const innerContent = contentToCheck.ephemeralMessage?.message || contentToCheck.viewOnceMessageV2?.message || contentToCheck.viewOnceMessage?.message || contentToCheck;

    const isQuotedImage =!!innerContent.imageMessage;
    const isQuotedVideo =!!innerContent.videoMessage;
    const isQuotedAudio =!!(innerContent.audioMessage || innerContent.pttMessage);
    const hasQuotedMedia = isQuotedImage || isQuotedVideo || isQuotedAudio;

    const isDirectImage =!!m.message?.imageMessage;
    const isDirectVideo =!!m.message?.videoMessage;
    const hasDirectMedia = isDirectImage || isDirectVideo;

    let hasMedia = hasQuotedMedia || hasDirectMedia;
    let finalContent = innerContent;
    let downloadTarget = hasQuotedMedia? targetMessage : m;

    if (hasDirectMedia) {
        finalContent = m.message.viewOnceMessageV2?.message || m.message.ephemeralMessage?.message || m.message;
        downloadTarget = m;
        hasMedia = true;
    }

    // Agar na text hai na media -> Example wala message bhejo (dusre bot jaisa)
    if (!statusText &&!hasMedia) {
        return reply(
            `⚠️ PROVIDE TEXT OR REPLY TO MEDIA!\n\n` +
            `EXAMPLES:\n` +
            `•.GCSTATUS HELLO (STATUS IN THIS GROUP)\n` +
            `•.GCSTATUS https://chat.whatsapp.com/xxxx HELLO (STATUS IN THAT GROUP VIA LINK)\n` +
            `•.GCSTATUS 12345678@g.us HELLO (STATUS IN THAT GROUP VIA JID)\n` +
            `• REPLY TO IMAGE/VIDEO WITH.GCSTATUS (MEDIA STATUS, SAME TARGETING RULES)`
        );
    }

    await sock.sendMessage(from, { react: { text: '⏳', key: m.key } });

    try {
        if (hasMedia) {
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

                await relayGroupStatus(sock, targetGroupJid, { groupStatusMessageV2: { message: finalMediaMessage } });
            }
        } else {
            const parts = splitTextPreservingFormat(statusText, WHATSAPP_STATUS_TEXT_LIMIT);
            for (const part of parts) {
                const randomHex = Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
                await relayGroupStatus(sock, targetGroupJid, {
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
        // Dusre bot jaisa success message
        return reply(`🎉 STATUS SENT TO:\n${targetGroupJid}`);
    } catch (error) {
        console.error('[GCSTATUS] error:', error);
        await sock.sendMessage(from, { react: { text: '❌', key: m.key } });
        return reply(`❌ Failed to post group status.\n${error.message}`);
    }
}

module.exports = gcstatus;
