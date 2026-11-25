import { describe, expect, it } from "vite-plus/test";
import { addComment, commentOp, listComments, replyComment } from "../src/services/comments";
import { claimImages, getImage, uploadImage } from "../src/services/bridge";
import { harness } from "./harness";

// Preview comments (services/comments.ts): the owner's comments reach the agent as one notify turn after the debounce; the agent's
// replies do not wake it; an owner reply in a resolved thread opens it again.

const anchor = { kind: "element", path: "/pricing", selector: "main > button", label: "button", component: "Upgrade", file: "src/Pricing.tsx", line: 12 };

describe("preview comments", () => {
  it("fold the owner's comments into one notify turn, and let the agent answer and resolve", () => {
    const h = harness();
    const id = h.seed("idle");
    const first = addComment(h.app, id, { body: "Make this blue", anchor, port: 5173 }).id;
    addComment(h.app, id, { body: "And bigger", anchor: { ...anchor, kind: "text", quote: "Simple plans", prefix: "", suffix: " for every team" }, port: 5173 });
    expect(h.hasTimer(id, "comments_notify")).toBe(true);

    h.timer(id, "comments_notify");
    const notify = h.cmds(id).filter((c) => c.kind === "notify");
    expect(notify).toHaveLength(1);
    expect(notify[0]!.text).toContain('<dorks-event source="preview">');
    expect(notify[0]!.text).toContain(`## New comment ${first} on /pricing, <button> in Upgrade (src/Pricing.tsx:12), port 5173`);
    expect(notify[0]!.text).toContain('the text "Simple plans"');
    expect(h.events(id).find((e) => e.body.type === "notify")?.body).toMatchObject({ source: "preview", text: "Make this blue\n\nAnd bigger" });

    // The agent answers and resolves: nothing new for it to hear about.
    commentOp(h.app, id, { action: "reply", id: first, body: "Done: it is blue now." });
    commentOp(h.app, id, { action: "resolve", id: first });
    expect(h.hasTimer(id, "comments_notify")).toBe(false);
    expect((commentOp(h.app, id, { action: "list" }) as { text: string }).text).not.toContain(first);

    // The owner writes again in the resolved thread: it opens and the agent hears about it.
    replyComment(h.app, id, first, "Not quite, darker please");
    expect(listComments(h.app, id).find((c) => c.id === first)?.resolvedAt).toBeNull();
    h.timer(id, "comments_notify");
    expect(
      h
        .cmds(id)
        .filter((c) => c.kind === "notify")
        .at(-1)!.text,
    ).toContain(`## Reply in thread ${first}`);
  });

  it("hand an area's screenshot to the agent as an image line, and make it the dork's", () => {
    const h = harness();
    const id = h.seed("idle");
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const image = uploadImage(h.app, png).id;
    addComment(h.app, id, { body: "Too much space here", anchor: { kind: "area", path: "/", selector: "", label: "area", rect: { x: 10, y: 400, width: 300, height: 120 }, image }, port: 3000 });
    h.timer(id, "comments_notify");
    const text = h.cmds(id).find((c) => c.kind === "notify")!.text;
    expect(text).toContain("the area at 10,400 (300 × 120 px)");
    expect(text).toContain(`![Screenshot of the area](dorks-image:${image})`);
    expect(getImage(h.app, id, image)).not.toBeNull();
  });

  it("take comments on the session's own images only, and show the agent the image and the spot", () => {
    const h = harness();
    const id = h.seed("idle");
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const image = uploadImage(h.app, png).id;
    const onImage = { kind: "image", image, label: "Settings", x: 0.3, y: 0.25 };
    // Not this session's image (yet): refused, so a comment cannot hand the agent someone else's picture.
    expect(() => addComment(h.app, id, { body: "Bluer", anchor: onImage, port: undefined })).toThrow();
    claimImages(h.app, id, `dorks-image:${image}`);
    addComment(h.app, id, { body: "Bluer", anchor: onImage, port: undefined });
    h.timer(id, "comments_notify");
    const text = h.cmds(id).find((c) => c.kind === "notify")!.text;
    expect(text).toContain(`on the image "Settings" (dorks-image:${image}), the point at 30%, 25% from its top-left corner`);
    expect(text).toContain(`![The image commented on](dorks-image:${image})`);
    expect(listComments(h.app, id)[0]!.port).toBeNull();
  });
});
