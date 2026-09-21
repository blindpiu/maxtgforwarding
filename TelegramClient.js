const axios = require("axios");
const http = require("http");
const https = require("https");

const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });
let maxDownloadAgentPromise = null;

async function getMaxDownloadAgent() {
    const proxyUrl = process.env.MAX_PROXY_URL;
    if (!proxyUrl) return null;

    if (!proxyUrl.startsWith("socks://") && !proxyUrl.startsWith("socks5://") && !proxyUrl.startsWith("socks5h://")) {
        throw new Error("MAX_PROXY_URL must use socks://, socks5:// or socks5h://");
    }

    if (!maxDownloadAgentPromise) {
        maxDownloadAgentPromise = import("socks-proxy-agent").then(({ SocksProxyAgent }) => {
            return new SocksProxyAgent(proxyUrl);
        });
    }

    return maxDownloadAgentPromise;
}

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

function isAudioFile(attach) {
    const previewType = String(attach?.preview?._type || "").toUpperCase();
    const mimeType = String(attach?.mimeType || attach?.payload?.mime_type || "").toLowerCase();
    const fileName = String(attach?.name || attach?.fileName || attach?.payload?.filename || "").toLowerCase();

    return previewType === "MUSIC"
        || mimeType.startsWith("audio/")
        || /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i.test(fileName);
}

async function postToTelegram(TG_BOT_TOKEN, method, payload) {
    const apiUrl = `https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`;

    try {
        const resp = await axios.post(apiUrl, payload, {
            httpAgent,
            httpsAgent,
            maxBodyLength: Infinity
        });
        console.log(`Sent via ${method}:`, resp.data);
        return true;
    } catch (e) {
        console.error(`Error in ${method}:`, e.response?.data || e.message);
        return false;
    }
}

async function downloadAttachment(url) {
    const proxyAgent = await getMaxDownloadAgent();
    const response = await axios.get(url, {
        responseType: "arraybuffer",
        httpAgent: proxyAgent || httpAgent,
        httpsAgent: proxyAgent || httpsAgent,
        maxContentLength: Infinity,
        timeout: 120000,
        headers: {
            "User-Agent": "Mozilla/5.0",
            Accept: "*/*"
        }
    });

    return {
        data: Buffer.from(response.data),
        contentType: response.headers?.["content-type"] || "application/octet-stream"
    };
}

function getFileName(attach, type) {
    const name = attach.name || attach.fileName || attach.payload?.filename;
    if (name) return String(name).split(/[\\/]/).pop();
    if (type === "VOICE") return "voice.ogg";
    if (type === "AUDIO") return "audio.mp3";
    return "file";
}

async function uploadToTelegram(TG_BOT_TOKEN, method, field, commonPayload, file, attach) {
    const form = new FormData();
    form.append("chat_id", String(commonPayload.chat_id));
    if (commonPayload.caption) form.append("caption", commonPayload.caption);
    if (commonPayload.parse_mode) form.append("parse_mode", commonPayload.parse_mode);
    form.append(
        field,
        new Blob([file.data], { type: file.contentType }),
        getFileName(attach, attach.telegramType)
    );

    return postToTelegram(TG_BOT_TOKEN, method, form);
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
            const telegramType = type === "FILE" && isAudioFile(attach) ? "AUDIO" : type;
            files.push({ ...attach, telegramType, telegramUrl: url });
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

        let downloadedFile = null;
        try {
            downloadedFile = await downloadAttachment(file.telegramUrl);
        } catch (e) {
            console.error(`Unable to download ${getFileName(file, file.telegramType)} from MAX:`, e.message);
        }

        let sent = false;
        if (downloadedFile) {
            if (file.telegramType === "AUDIO") {
                sent = await uploadToTelegram(
                    TG_BOT_TOKEN, "sendAudio", "audio", commonPayload, downloadedFile, file
                );
            } else if (file.telegramType === "VOICE") {
                sent = await uploadToTelegram(
                    TG_BOT_TOKEN, "sendVoice", "voice", commonPayload, downloadedFile, file
                );
            }

            // Документы и аудио неподдерживаемого Telegram формата отправляем как файл.
            if (!sent) {
                sent = await uploadToTelegram(
                    TG_BOT_TOKEN, "sendDocument", "document", commonPayload, downloadedFile, file
                );
            }
        } else {
            // Запасной вариант, если мост не смог сам скачать файл.
            const method = file.telegramType === "AUDIO"
                ? "sendAudio"
                : file.telegramType === "VOICE" ? "sendVoice" : "sendDocument";
            const field = file.telegramType === "AUDIO"
                ? "audio"
                : file.telegramType === "VOICE" ? "voice" : "document";
            sent = await postToTelegram(TG_BOT_TOKEN, method, {
                ...commonPayload,
                [field]: file.telegramUrl
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
