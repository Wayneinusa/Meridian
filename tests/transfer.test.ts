import { describe, expect, it } from "vitest";
import { chatToHtml, chatToMarkdown, detectAndImport } from "../src/storage/transfer";

describe("chat import / export", () => {
  it("imports the visible branch of a ChatGPT export", () => {
    const data = [
      {
        title: "Trip",
        create_time: 1700000000.5,
        current_node: "c",
        mapping: {
          root: { message: null, parent: null },
          a: { parent: "root", message: { author: { role: "user" }, content: { parts: ["Plan a trip"] }, create_time: 1700000001 } },
          old: { parent: "a", message: { author: { role: "assistant" }, content: { parts: ["old answer"] } } },
          c: { parent: "a", message: { author: { role: "assistant" }, content: { parts: ["Here is a plan"] }, create_time: 1700000002 } },
        },
      },
    ];
    const { source, chats } = detectAndImport(JSON.stringify(data));
    expect(source).toBe("ChatGPT");
    expect(chats[0].title).toBe("Trip");
    expect(chats[0].messages.map((m) => [m.role, (m.parts.at(-1) as { text: string }).text])).toEqual([["user", "Plan a trip"], ["assistant", "Here is a plan"]]);
    expect(chats[0].createdAt).toBe(1700000000500);
  });

  it("imports Claude and TypingMind exports", () => {
    const claude = [{ name: "Essay", created_at: "2025-01-02T03:04:05Z", chat_messages: [{ sender: "human", text: "Hi", attachments: [{ file_name: "a.pdf" }] }, { sender: "assistant", text: "Hello" }] }];
    const r = detectAndImport(JSON.stringify(claude));
    expect(r.source).toBe("Claude");
    expect((r.chats[0].messages[0].parts[0] as { text: string }).text).toBe("[attached: a.pdf]\n\nHi");
    const tm = { data: { chats: [{ chatTitle: "TM", messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "text", text: "a" }] }] }] } };
    expect(detectAndImport(JSON.stringify(tm)).chats[0].messages).toHaveLength(2);
    expect(() => detectAndImport("{}")).toThrow(/not a ChatGPT/);
  });

  it("exports Markdown and HTML", () => {
    const c = { id: "c", title: "T", createdAt: 0, updatedAt: 0, removed: {}, messages: [{ id: "1", role: "user" as const, createdAt: 0, updatedAt: 0, parts: [{ type: "text" as const, text: "Hi **there**" }] }] };
    expect(chatToMarkdown(c)).toContain("## You\n\nHi **there**");
    expect(chatToHtml(c)).toContain("<strong>there</strong>");
  });
});
