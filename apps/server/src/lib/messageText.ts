/** A message without its attached images (`![name](dorks-image:<id>)`), for titles and previews. */
export const withoutImages = (text: string) => text.replace(/!\[[^\]]*\]\(\s*dorks-image:[0-9a-f]{32}\s*\)/g, "").trim();
/** A reply's quote (`> Replying to …` lines the web puts first, see apps/web/src/lib/reply.ts) is not what the owner wrote. */
export const withoutReply = (text: string) => (/^> Replying to (this part of your message|this image):\n/.test(text) ? text.replace(/^(>.*(\n|$))+/, "") : text);
/** The dork list's one-line preview of a message the owner sent. */
export const messagePreview = (text: string) => (withoutImages(withoutReply(text)) || "Image").slice(0, 140);
