const axios = require("axios");

function handleAttach(attach) {
    switch (attach._type) {
        case "FILE":
            return attach.name;
        case "SHARE":
            return attach.title || attach.url || "SHARE";
        default:
            return attach._type;
    }
}

function getAttachUrl(attach) {
    if (attach._type === "PHOTO") return attach.baseUrl || attach.url;
    if (attach._type === "FILE") return attach.baseUrl || attach.url;
    if (attach._type === "SHARE" && attach.image && attach.image._type === "PHOTO") {
        return attach.image.url;
    }
    return null;
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
    const docs = [];

    for (const attach of attachments) {
        const url = getAttachUrl(attach);
        if (!url) {
            // необработанные файлы можно добавить в caption
            continue;
        }

        if ((attach._type === "PHOTO") || (attach._type === "SHARE" && attach.image)) {
            photos.push({ ...attach, baseUrl: url });
        } else if (attach._type === "FILE") {
            docs.push({ ...attach, baseUrl: url });
        }
    }

    // 1️⃣ Отправка фото (альбомы по 10)
    for (let i = 0; i < photos.length; i += 10) {
        const chunk = photos.slice(i, i + 10);
        const media = chunk.map((p, idx) => {
            const item = { type: "photo", media: p.baseUrl };
            if (idx === 0 && caption) {
                item.caption = caption;
                item.parse_mode = "HTML";
            }
            return item;
        });

        try {
            const apiUrl = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMediaGroup`;
            const resp = await axios.post(apiUrl, { chat_id: TG_CHAT_ID, media: JSON.stringify(media) });
            console.log("Sent photo album:", resp.data);
        } catch (e) {
            console.error("Error sending photo album:", e.response?.data || e.message);
        }
    }

    // 2️⃣ Отправка документов
    for (const doc of docs) {
        try {
            const apiUrl = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`;
            const payload = {
                chat_id: TG_CHAT_ID,
                caption: caption || handleAttach(doc),
                parse_mode: "HTML",
                document: doc.baseUrl
            };
            const resp = await axios.post(apiUrl, payload);
            console.log("Sent document:", resp.data);
        } catch (e) {
            console.error("Error sending document:", e.response?.data || e.message);
        }
    }

    // 3️⃣ Если нет вложений, но есть только текст
    if (!attachments.length && caption) {
        try {
            const apiUrl = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
            const resp = await axios.post(apiUrl, {
                chat_id: TG_CHAT_ID,
                text: caption,
                parse_mode: "HTML"
            });
            console.log("Sent text:", resp.data);
        } catch (e) {
            console.error("Error sending text:", e.response?.data || e.message);
        }
    }
}

module.exports = sendToTelegram;