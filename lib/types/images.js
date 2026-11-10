/**
 * Images a chat message carried. Sending a screenshot is how someone shows a
 * problem, so an image the model never receives is worse than a missing
 * feature: the model answers as if it had seen one. Every image that cannot be
 * attached therefore leaves a note in the text instead of disappearing.
 * @module dsh-lark-bridge/images
 */
/**
 * The media type to declare for stored bytes: the transport's own, when it
 * names one the store accepts, else the file name's extension.
 * @param contentType - transport-reported type, possibly parameterized.
 * @param fileName - the sender's file name, when the message carried one.
 * @param accepted - media types this deployment's store accepts.
 * @returns the media type to declare, or undefined when nothing matches.
 */
function mediaTypeOf(contentType, fileName, accepted) {
    const declared = contentType?.split(';')[0]?.trim().toLowerCase();
    if (declared !== undefined && accepted.includes(declared))
        return declared;
    const extension = fileName?.toLowerCase().split('.').pop();
    const fromName = extension === 'jpg' || extension === 'jpeg'
        ? 'image/jpeg'
        : extension === undefined ? undefined : `image/${extension}`;
    return fromName !== undefined && accepted.includes(fromName) ? fromName : undefined;
}
/**
 * Download and commit the images one message carried.
 *
 * Bounds come from the store rather than this plugin: it is the component that
 * knows what a model request may carry. An image past them is skipped with a
 * note, as is one whose type the store does not accept.
 * @param msg - the inbound message.
 * @param port - transport used to download the bytes.
 * @param attachments - the attachment store, when composed.
 * @param enabled - whether this deployment's route accepts images at all.
 * @param report - where attachment failures go, so the log names them too.
 * @param sourceMessageId - the message that actually CARRIES these resources.
 *   Feishu's "share/quote" sends the image as its own message and the text as a
 *   reply that names it; the reply's event still lists the image in
 *   `resources`, but the resource can only be fetched from the message it
 *   belongs to. Asking the text message's id returns HTTP 400 (2026-11-11:
 *   「分享过来带文字，图片就附加失败」). Defaults to the message itself.
 * @returns the blocks to attach and the notes to append to the text.
 */
export async function collectImages(msg, port, attachments, enabled, report, sourceMessageId = msg.messageId) {
    const images = msg.resources.filter((resource) => resource.type === 'image');
    if (images.length === 0)
        return { blocks: [], notes: [] };
    if (!enabled) {
        // The model is told, because a sender who attaches a screenshot is talking
        // about it — and answering as though it were visible is the worst outcome.
        return {
            blocks: [],
            notes: [`（用户发送了 ${images.length} 张图片，本渠道未向模型传递图片：attachImages 未开启）`],
        };
    }
    if (attachments === undefined) {
        return { blocks: [], notes: [`（用户发送了 ${images.length} 张图片，但本部署没有组合附件存储，模型看不到它们）`] };
    }
    const limits = attachments.imageLimits;
    const blocks = [];
    const notes = [];
    let budget = limits.maxMessageImageBytes;
    for (const [index, image] of images.entries()) {
        if (index >= limits.maxImagesPerMessage) {
            notes.push(`（还有 ${images.length - index} 张图片超出单条消息上限，未附加）`);
            break;
        }
        try {
            const { buffer, contentType } = await port.downloadResourceWithMeta(sourceMessageId, image.fileKey, 'image');
            const mediaType = mediaTypeOf(contentType, image.fileName, limits.mediaTypes);
            if (mediaType === undefined) {
                notes.push(`（一张图片的格式 ${contentType ?? '未知'} 不被支持，未附加）`);
                continue;
            }
            if (buffer.byteLength > limits.maxImageBytes || buffer.byteLength > budget) {
                notes.push('（一张图片超出大小上限，未附加）');
                continue;
            }
            const ref = await attachments.saveImage({
                data: buffer,
                mediaType,
                ...image.fileName === undefined ? {} : { name: image.fileName },
            });
            budget -= buffer.byteLength;
            blocks.push({ type: 'image', attachment: ref });
        }
        catch (error) {
            // The model must know an image existed even when it cannot be shown one.
            const detail = error instanceof Error ? error.message : String(error);
            // The log gets the same line: a note only the model reads leaves whoever
            // debugs it guessing, and the store's own refusal codes
            // (IMAGE_TYPE_MISMATCH, INVALID_IMAGE, ATTACHMENT_WRITE_FAILED) are the
            // whole diagnosis.
            report?.(`image ${image.fileKey} of ${sourceMessageId} not attached: ${detail}`);
            notes.push(`（一张图片附加失败：${detail}）`);
        }
    }
    return { blocks, notes };
}
//# sourceMappingURL=images.js.map