const axios = require("axios");

function getAttachType(attach) {
    return String(attach?._type || attach?.type || "UNKNOWN").toUpperCase();
}

function handleAttach(attach) {
    const type = getAttachType(attach);

    if (type === "FILE") {
        return attach.name || attach.fileName || attach.payload?.filename || "FILE";
    }

    if (type === "AUDIO" || type === "VOICE") {
        return attach.title || attach.name || attach.payload?.filename || type;
    }

    if (type === "SHARE") {
        return attach.title || attach.url || "SHARE";
    }

    return type;
}

function getAttachUrl(attach) {
    return attach?.baseUrl
        || attach?.url
        || attach?.payload?.url
        || attach?.payload?.link
        || null;
}

async function postToTelegram(TG_BOT_TOKEN, method, payload) {
    const apiUrl = `https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`;

    try {
        const resp = await axios.post(apiUrl, payload);
        console.log(`Sent via ${method}:`, resp.data);
        return true;
    } catch (e) {
        console.error(`Error in ${method}:`, e.response?.data || e.message);
        return false;
    }
}

/**
 * Отправка текста и вложений в Telegram.
 * @param {string} TG_BOT_TOKEN
 * @param {number|string} TG_CHAT_ID
 * @param {string} caption
 * @param {Array<Object>} attachments
 */
async function sendToTelegram(TG_BOT_TOKEN = "", TG_CHAT_ID = 0, caption = "", attachments = []) {
    const photos = [];
    const files = [];
    const skipped = [];

    for (const attach of attachments) {
        const type = getAttachType(attach);
        let url = getAttachUrl(attach);

        if (type === "SHARE" && attach.image) {
            url = getAttachUrl(attach.image);
        }

        if (!url) {
            skipped.push(attach);
            continue;
        }

        if (type === "PHOTO" || type === "IMAGE" || (type === "SHARE" && attach.image)) {
            photos.push({ ...attach, telegramUrl: url });
        } else if (["FILE", "AUDIO", "VOICE"].includes(type)) {
            files.push({ ...attach, telegramType: type, telegramUrl: url });
        } else {
            skipped.push(attach);
        }
    }

    let messageCaption = caption;
    if (skipped.length) {
        const skippedText = `Необработанные вложения: ${skipped.map(handleAttach).join(", ")}`;
        messageCaption = messageCaption ? `${messageCaption}\n\n${skippedText}` : skippedText;
    }

    let captionSent = false;

    // Фото отправляются альбомами не более чем по 10 элементов.
    for (let i = 0; i < photos.length; i += 10) {
        const chunk = photos.slice(i, i + 10);
        const media = chunk.map((photo, idx) => {
            const item = { type: "photo", media: photo.telegramUrl };
            if (!captionSent && idx === 0 && messageCaption) {
                item.caption = messageCaption;
                item.parse_mode = "HTML";
            }
            return item;
        });

        const sent = await postToTelegram(TG_BOT_TOKEN, "sendMediaGroup", {
            chat_id: TG_CHAT_ID,
            media: JSON.stringify(media)
        });
        if (sent && messageCaption) captionSent = true;
    }

    for (const file of files) {
        const fileCaption = !captionSent ? (messageCaption || handleAttach(file)) : "";
        const commonPayload = {
            chat_id: TG_CHAT_ID,
            caption: fileCaption,
            parse_mode: "HTML"
        };

        let sent = false;
        if (file.telegramType === "AUDIO") {
            sent = await postToTelegram(TG_BOT_TOKEN, "sendAudio", {
                ...commonPayload,
                audio: file.telegramUrl
            });
        } else if (file.telegramType === "VOICE") {
            sent = await postToTelegram(TG_BOT_TOKEN, "sendVoice", {
                ...commonPayload,
                voice: file.telegramUrl
            });
        }

        // Если Telegram не принял формат аудио, пересылаем его как обычный файл.
        if (!sent) {
            sent = await postToTelegram(TG_BOT_TOKEN, "sendDocument", {
                ...commonPayload,
                document: file.telegramUrl
            });
        }

        if (sent && fileCaption) captionSent = true;
    }

    // Даже неизвестное вложение не должно приводить к потере текста сообщения.
    if (!captionSent && messageCaption) {
        await postToTelegram(TG_BOT_TOKEN, "sendMessage", {
            chat_id: TG_CHAT_ID,
            text: messageCaption,
            parse_mode: "HTML"
        });
    }
}

module.exports = sendToTelegram;
