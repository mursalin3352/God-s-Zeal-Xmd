/**
 * Group Status Command - CLEAN - No Spam, No Duplicate Pic
 * Fixed for your requirement
 */

const { PassThrough } = require("stream");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegStatic);

const TEMP_DIR = path.join(__dirname, '../../tmp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const PURPLE_COLOR = "#9C27B0";

function detectMediaType(message) {
    if (!message || typeof message!== "object") return null;
    if (message.imageMessage) return "image";
    if (message.videoMessage) return "video";
    if (message.audioMessage) return "audio";
    if (message.stickerMessage) return "sticker";
    return null;
}

function unwrapQuotedMessage(message) {
    let current = message;
    for (let i = 0; i < 4; i++) {
        const wrapper = current?.viewOnceMessageV2 || current?.viewOnceMessage || current?.viewOnceMessageV2Extension || current?.documentWithCaptionMessage;
        if (!wrapper?.message) break;
        current = wrapper.message;
    }
    return current;
}

async function downloadMedia(message, type) {
    const mediaMessage = message[`${type}Message`];
    if (!mediaMessage) throw new Error(`Missing ${type} message payload.`);
    const stream = await downloadContentFromMessage(mediaMessage, type);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function postGroupStatus(client, jid, content) {
    const statusSourceType = content.text? "TEXT" : content.image? "IMAGE" : content.video? "VIDEO" : content.audio? "AUDIO" : content.sticker? "IMAGE" : "TEXT";
    return client.sendMessage(jid, {
      ...content,
        contextInfo: {
          ...(content.contextInfo || {}),
            isGroupStatus: true,
            statusSourceType,
            statusAttributions: [{ type: 10 }],
            statusAudienceMetadata: { audienceType: "CLOSE_FRIENDS" }
        }
    });
}

async function convertToVoiceNote(buffer) {
    return new Promise((resolve, reject) => {
        const input = new PassThrough();
        const output = new PassThrough();
        const chunks = [];
        input.end(buffer);
        output.on("data", (chunk) => chunks.push(chunk));
        ffmpeg(input).noVideo().audioCodec("libopus").format("ogg").audioChannels(1).audioFrequency(48000).on("error", reject).on("end", () => resolve(Buffer.concat(chunks))).pipe(output);
    });
}

async function generateWaveform(buffer, bars = 64) {
    return new Promise((resolve, reject) => {
        const input = new PassThrough();
        const chunks = [];
        input.end(buffer);
        ffmpeg(input).audioChannels(1).audioFrequency(16000).format("s16le").on("error", reject).on("end", () => {
                const raw = Buffer.concat(chunks);
                const samples = Math.floor(raw.length / 2);
                if (!samples) return resolve(undefined);
                const amplitudes = [];
                for (let i = 0; i < samples; i++) { amplitudes.push(Math.abs(raw.readInt16LE(i * 2)) / 32768); }
                const size = Math.floor(amplitudes.length / bars);
                if (!size) return resolve(undefined);
                const averages = Array.from({ length: bars }, (_, index) => {
                    const slice = amplitudes.slice(index * size, (index + 1) * size);
                    return slice.reduce((sum, value) => sum + value, 0) / slice.length;
                });
                const max = Math.max(...averages);
                if (!max) return resolve(undefined);
                resolve(Buffer.from(averages.map((value) => Math.floor((value / max) * 100))).toString("base64"));
            }).pipe().on("data", (chunk) => chunks.push(chunk));
    });
}

async function gcstatus(sock, chatId, message, inputText) {
    const caption = (Array.isArray(inputText)? inputText.join(' ') : (inputText || '')).trim();

    if (!chatId.endsWith('@g.us')) return;

    const quotedMessage = message.message?.extendedTextMessage?.contextInfo?.quotedMessage
        || message.message?.imageMessage?.contextInfo?.quotedMessage
        || message.message?.videoMessage?.contextInfo?.quotedMessage;

    if (!quotedMessage) {
        if (!caption) return;
        try {
            await postGroupStatus(sock, chatId, { text: caption, backgroundColor: PURPLE_COLOR });
            await sock.sendMessage(chatId, { react: { text: "✅", key: message.key } });
        } catch (e) {
            await sock.sendMessage(chatId, { react: { text: "❌", key: message.key } });
        }
        return;
    }

    const mediaPayload = unwrapQuotedMessage(quotedMessage);
    const mediaType = detectMediaType(mediaPayload);
    if (!mediaType) return;

    try {
        const buffer = await downloadMedia(mediaPayload, mediaType);
        if (!buffer?.length) throw new Error("Download failed");

        if (mediaType === "audio") {
            const voiceNote = await convertToVoiceNote(buffer);
            const waveform = await generateWaveform(buffer).catch(() => undefined);
            await postGroupStatus(sock, chatId, { audio: voiceNote, mimetype: "audio/ogg; codecs=opus", ptt: true, waveform });
        } else if (mediaType === "sticker") {
            await postGroupStatus(sock, chatId, { sticker: buffer });
        } else {
            await postGroupStatus(sock, chatId, { [mediaType]: buffer, caption: caption || '' });
        }
        await sock.sendMessage(chatId, { react: { text: "✅", key: message.key } });
    } catch (error) {
        console.error(error);
        await sock.sendMessage(chatId, { react: { text: "❌", key: message.key } });
    }
}

module.exports = gcstatus;
