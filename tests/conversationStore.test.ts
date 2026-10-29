import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CONVERSATION_KEY,
  CONVERSATION_TTL_MS,
  MAX_STORED_MESSAGES,
  clearConversation,
  loadConversation,
  messagesToStore,
  saveConversation,
  type KeyValueStore,
  type StorableMessage,
} from "../lib/runtime/conversationStore.ts";

// Offline: the store and the clock are injected, so persistence, expiry and the
// explicit reset are tested without a browser.

class MemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

interface Msg extends StorableMessage {
  sources?: { documentTitle: string }[];
  sentAt?: number;
  showCommentBox?: boolean;
}

const user = (text: string): Msg => ({ role: "user", text });
const assistant = (text: string, extra: Partial<Msg> = {}): Msg => ({ role: "assistant", text, ...extra });
const H = 60 * 60 * 1000;

describe("save and load", () => {
  test("a saved conversation comes back unchanged, with its id and extra fields", () => {
    const store = new MemoryStore();
    const messages = [user("hi"), assistant("hello", { sources: [{ documentTitle: "Doc" }] })];
    saveConversation(store, "abc", messages, 1000);
    const loaded = loadConversation<Msg>(store, 2000);
    assert.equal(loaded?.id, "abc");
    assert.deepEqual(loaded?.messages, messages);
  });

  test("transient page-only fields are not stored", () => {
    const store = new MemoryStore();
    saveConversation(store, "abc", [user("q"), assistant("a", { sentAt: 123.4, showCommentBox: true })], 1000);
    const [, a] = loadConversation<Msg>(store, 1001)!.messages;
    assert.equal("sentAt" in a, false);
    assert.equal("showCommentBox" in a, false);
  });

  test("nothing stored means nothing loaded", () => {
    assert.equal(loadConversation<Msg>(new MemoryStore(), 1000), null);
  });
});

describe("expiry", () => {
  test("the conversation survives up to the TTL and is dropped after it, and the entry is deleted", () => {
    const store = new MemoryStore();
    saveConversation(store, "abc", [user("q"), assistant("a")], 0);
    assert.ok(loadConversation<Msg>(store, CONVERSATION_TTL_MS - 1));
    assert.equal(loadConversation<Msg>(store, CONVERSATION_TTL_MS), null);
    assert.equal(store.getItem(CONVERSATION_KEY), null);
  });

  test("the window slides: each save pushes the expiry out", () => {
    const store = new MemoryStore();
    saveConversation(store, "abc", [user("q"), assistant("a")], 0);
    saveConversation(store, "abc", [user("q"), assistant("a"), user("q2"), assistant("a2")], 20 * H);
    assert.ok(loadConversation<Msg>(store, 40 * H), "20h after the last message is inside the 24h window");
    assert.equal(loadConversation<Msg>(store, 20 * H + CONVERSATION_TTL_MS), null);
  });

  test("a custom TTL is honoured; the default is 24 hours", () => {
    assert.equal(CONVERSATION_TTL_MS, 24 * H);
    const store = new MemoryStore();
    saveConversation(store, "abc", [user("q"), assistant("a")], 0);
    assert.equal(loadConversation<Msg>(store, 2 * H, 1 * H), null);
  });

  test("an entry dated in the future (clock change) is dropped, not trusted", () => {
    const store = new MemoryStore();
    saveConversation(store, "abc", [user("q"), assistant("a")], 10 * H);
    assert.equal(loadConversation<Msg>(store, 0), null);
  });
});

describe("explicit reset", () => {
  test("clearing is the New conversation action: nothing loads afterwards", () => {
    const store = new MemoryStore();
    saveConversation(store, "abc", [user("q"), assistant("a")], 0);
    clearConversation(store);
    assert.equal(loadConversation<Msg>(store, 1), null);
  });

  test("saving an empty conversation removes the entry", () => {
    const store = new MemoryStore();
    saveConversation(store, "abc", [user("q"), assistant("a")], 0);
    saveConversation(store, "abc", [], 1);
    assert.equal(store.getItem(CONVERSATION_KEY), null);
  });
});

describe("what is worth keeping", () => {
  test("a half-written answer is dropped together with its question", () => {
    const kept = messagesToStore([user("q1"), assistant("a1"), user("q2"), assistant("part", { isStreaming: true })]);
    assert.deepEqual(kept.map((m) => m.text), ["q1", "a1"]);
  });

  test("an answer that is still empty and not failed is dropped with its question; a failed one is kept", () => {
    assert.equal(messagesToStore([user("q"), assistant("")]).length, 0);
    assert.equal(messagesToStore([user("q"), assistant("", { error: "unavailable" })]).length, 2);
  });

  test("only the most recent messages are kept", () => {
    const many = Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? user(`q${i}`) : assistant(`a${i}`)));
    const kept = messagesToStore(many);
    assert.equal(kept.length, MAX_STORED_MESSAGES);
    assert.equal(kept[kept.length - 1].text, "a79");
  });

  test("a very large conversation is trimmed from the oldest end rather than refused", () => {
    const store = new MemoryStore();
    const big = "x".repeat(400_000);
    saveConversation(store, "abc", [user(big), assistant(big), user(big), assistant(big), user("recent"), assistant("latest")], 0);
    const loaded = loadConversation<Msg>(store, 1)!;
    assert.equal(loaded.messages[loaded.messages.length - 1].text, "latest");
    assert.ok(JSON.stringify(loaded).length <= 1_600_000);
  });
});

describe("failure handling", () => {
  test("corrupt, wrong-version or malformed entries load as nothing and are deleted", () => {
    for (const raw of ["{not json", JSON.stringify({ version: 2, id: "a", updatedAt: 0, messages: [] }), JSON.stringify({ version: 1, id: "a", updatedAt: 0, messages: [{ role: "robot", text: "x" }] }), JSON.stringify({ version: 1, id: "", updatedAt: 0, messages: [] })]) {
      const store = new MemoryStore();
      store.setItem(CONVERSATION_KEY, raw);
      assert.equal(loadConversation<Msg>(store, 1), null, raw);
      assert.equal(store.getItem(CONVERSATION_KEY), null);
    }
  });

  test("a store that throws never breaks the conversation", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    assert.doesNotThrow(() => saveConversation(broken, "a", [user("q"), assistant("a")], 0));
    assert.equal(loadConversation<Msg>(broken, 1), null);
    assert.doesNotThrow(() => clearConversation(broken));
  });
});
