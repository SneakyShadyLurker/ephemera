import { describe, expect, it, vi } from "vitest";
import { thrownFailure } from "../sheet/saving.ts";
import { createIdentity, IdentityChanged } from "./identity.ts";
import { createSignIn, notReached, RENEWAL_PASS_MS, retryable, SignedOut } from "./signin.ts";

function channelDouble() {
  const opened: { messages: ((data: unknown) => void)[]; closed: boolean }[] = [];
  return {
    opened,
    create: () => {
      const channel = { messages: [] as ((data: unknown) => void)[], closed: false };
      opened.push(channel);
      return {
        listen: (handler: (data: unknown) => void) => channel.messages.push(handler),
        close: () => {
          channel.closed = true;
        },
      };
    },
    /** Posts to every open channel, as the renewed page does. */
    post: (data: unknown) => {
      for (const channel of opened)
        if (!channel.closed) for (const handler of channel.messages) handler(data);
    },
  };
}

/** A tab bound to `user`, or unbound as in development. */
function setup(user?: string) {
  const channels = channelDouble();
  const open = vi.fn();
  const leave = vi.fn();
  const identity = createIdentity(() => user, leave);
  const signIn = createSignIn({ open, channel: channels.create, identity });
  return { signIn, open, channels, identity, leave, phase: () => signIn.store.getState().phase };
}

describe("sign-in state", () => {
  it("starts signed in and opens no channel", () => {
    const { phase, channels } = setup();
    expect(phase()).toBe("active");
    expect(channels.opened).toHaveLength(0);
  });

  it("listens for a renewal only while signed out", async () => {
    const { signIn, channels, phase } = setup();
    signIn.signedOut();
    expect(phase()).toBe("expired");
    expect(channels.opened).toHaveLength(1);
    channels.post({ type: "renewed" });
    await vi.waitFor(() => expect(phase()).toBe("renewed"));
    expect(channels.opened[0]?.closed).toBe(true);
  });

  it("a renewal as the tab's own user resumes as before", async () => {
    const { signIn, channels, leave, phase } = setup("alice");
    const resume = vi.fn(async () => "edits" as const);
    signIn.onRenewed(resume);
    signIn.signedOut();
    channels.post({ type: "renewed", user: "alice" });
    await vi.waitFor(() => expect(phase()).toBe("renewed"));
    expect(resume).toHaveBeenCalledOnce();
    expect(leave).not.toHaveBeenCalled();
  });

  it("a renewal as another user resumes nothing and leaves the tab", async () => {
    const { signIn, channels, identity, leave, phase } = setup("alice");
    const resume = vi.fn(async () => "send" as const);
    signIn.onRenewed(resume, "resume");
    signIn.onRenewed(resume);
    signIn.signedOut();
    channels.post({ type: "renewed", user: "bob" });
    await Promise.resolve();
    expect(leave).toHaveBeenCalledOnce();
    expect(identity.hasChanged()).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    expect(phase()).toBe("expired");
    expect(channels.opened[0]?.closed).toBe(true);
  });

  it("ignores messages that are not a renewal", async () => {
    const { signIn, channels, phase } = setup();
    signIn.signedOut();
    channels.post({ type: "renewed", extra: "text" });
    channels.post("renewed");
    await Promise.resolve();
    expect(phase()).toBe("expired");
  });

  it("opens the renewal page in a new window without an opener and waits", () => {
    const { signIn, open, phase } = setup();
    signIn.signedOut();
    signIn.signIn();
    expect(open).toHaveBeenCalledWith("/auth/renewed");
    expect(phase()).toBe("waiting");
    // A request refused while the owner signs in changes nothing.
    signIn.signedOut();
    expect(phase()).toBe("waiting");
  });

  it("runs every renewal listener once per renewal and reports what resumed", async () => {
    const { signIn, phase } = setup();
    const chat = vi.fn(async () => "send" as const);
    const edits = vi.fn(async () => "edits" as const);
    signIn.onRenewed(chat);
    signIn.onRenewed(edits);
    signIn.signedOut();
    await signIn.renewed();
    expect(chat).toHaveBeenCalledOnce();
    expect(edits).toHaveBeenCalledOnce();
    expect(phase()).toBe("renewed");
    expect(signIn.store.getState().resumed).toBe("send");
    // A second announcement while signed in does nothing.
    await signIn.renewed();
    expect(chat).toHaveBeenCalledOnce();
  });

  it("says still signed out when a retry is refused again, and listens again", async () => {
    const { signIn, channels, phase } = setup();
    signIn.onRenewed(async () => {
      signIn.signedOut();
    });
    signIn.signedOut();
    await signIn.renewed();
    expect(phase()).toBe("still-expired");
    expect(channels.opened.at(-1)?.closed).toBe(false);
  });

  it("a listener that throws does not stop the others", async () => {
    const { signIn, phase } = setup();
    const after = vi.fn();
    signIn.onRenewed(async () => {
      throw new Error("boom");
    });
    signIn.onRenewed(after);
    signIn.signedOut();
    await signIn.renewed();
    expect(after).toHaveBeenCalledOnce();
    expect(phase()).toBe("renewed");
  });

  it("takes a request answered after the tab signed out as a renewal, never an older one", async () => {
    const { signIn, phase } = setup();
    const before = signIn.outage();
    expect(before).toBeNull();
    signIn.signedOut();
    const during = signIn.outage();
    expect(during).not.toBeNull();
    signIn.confirmed(before);
    expect(phase()).toBe("expired");
    signIn.confirmed(during);
    await vi.waitFor(() => expect(phase()).toBe("renewed"));
  });

  it("dismissing the renewed notice returns to signed in", async () => {
    const { signIn, phase } = setup();
    signIn.signedOut();
    await signIn.renewed();
    signIn.dismiss();
    expect(phase()).toBe("active");
  });

  it("counts edits waiting for a session until they are released", () => {
    const { signIn } = setup();
    const release = signIn.holdEdits();
    const other = signIn.holdEdits();
    expect(signIn.store.getState().edits).toBe(2);
    release();
    release();
    expect(signIn.store.getState().edits).toBe(1);
    other();
    expect(signIn.store.getState().edits).toBe(0);
  });

  it("never retries a signed-out request, only a stale refusal of an older one", () => {
    expect(retryable(new SignedOut())).toBe(false);
    expect(retryable(new SignedOut(true))).toBe(true);
    expect(thrownFailure(new SignedOut())).toBe("signed_out");
    expect(thrownFailure(new SignedOut(true))).toBe("unreachable");
    expect(retryable(new Error("unreachable"))).toBe(true);
    expect(retryable(new IdentityChanged())).toBe(false);
  });

  it("a refusal of a request sent before the renewal does not undo it", async () => {
    const { signIn, phase } = setup();
    signIn.signedOut();
    const before = signIn.pass();
    signIn.onRenewed(async () => {
      // An older request, still in flight when the renewal began, is refused late.
      signIn.signedOut(before);
    });
    await signIn.renewed();
    expect(phase()).toBe("renewed");
  });

  it("a refusal of a request sent during the renewal still counts", async () => {
    const { signIn, phase } = setup();
    signIn.signedOut();
    signIn.onRenewed(async () => {
      signIn.signedOut(signIn.pass());
    });
    await signIn.renewed();
    expect(phase()).toBe("still-expired");
  });

  it("a refusal of a request sent before the renewal is ignored after it too", async () => {
    const { signIn, phase } = setup();
    signIn.signedOut();
    const before = signIn.pass();
    await signIn.renewed();
    signIn.signedOut(before);
    expect(phase()).toBe("renewed");
    signIn.dismiss();
    signIn.signedOut(before);
    expect(phase()).toBe("active");
    // A request sent after the renewal still counts.
    signIn.signedOut(signIn.pass());
    expect(phase()).toBe("expired");
  });

  it("saves settle before the waiting generation resumes", async () => {
    const { signIn } = setup();
    const order: string[] = [];
    signIn.onRenewed(async () => {
      order.push("resume");
    }, "resume");
    signIn.onRenewed(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("save");
    });
    signIn.signedOut();
    await signIn.renewed();
    expect(order).toEqual(["save", "resume"]);
  });

  it("past the bound, the waiting generation still waits for the saves, and not past a new expiry", async () => {
    vi.useFakeTimers();
    try {
      const { signIn, phase } = setup();
      let finishSave: () => void = () => {};
      signIn.onRenewed(() => new Promise<void>((resolve) => (finishSave = resolve)));
      const resumed = vi.fn();
      signIn.onRenewed(resumed, "resume");
      signIn.signedOut();
      const renewing = signIn.renewed();
      await vi.advanceTimersByTimeAsync(RENEWAL_PASS_MS);
      await renewing;
      expect(phase()).toBe("renewed");
      expect(signIn.savesSettled()).toBe(false);
      expect(resumed).not.toHaveBeenCalled();
      // The session goes again before the slow save ends: nothing resumes into it.
      signIn.signedOut(signIn.pass());
      finishSave();
      await vi.advanceTimersByTimeAsync(0);
      expect(resumed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late refusal of an older request says it is stale, so its owner can retry", () => {
    const { signIn } = setup();
    signIn.signedOut();
    const before = signIn.pass();
    return signIn.renewed().then(() => {
      expect(signIn.signedOut(before)).toBe(false);
      expect(signIn.signedOut(signIn.pass())).toBe(true);
    });
  });

  it("a renewal pass that hangs ends after its bound, and the tab is signed in", async () => {
    vi.useFakeTimers();
    try {
      const { signIn, phase } = setup();
      signIn.onRenewed(() => new Promise(() => {}));
      signIn.onRenewed(async () => "edits" as const);
      signIn.signedOut();
      const renewing = signIn.renewed();
      await vi.advanceTimersByTimeAsync(RENEWAL_PASS_MS);
      await renewing;
      expect(phase()).toBe("renewed");
      expect(signIn.store.getState().resumed).toBe("edits");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("why a one-shot action failed", () => {
  it("says signed out while the session is gone, unreachable otherwise", () => {
    const { signIn } = setup();
    expect(notReached(signIn.store.getState().phase)).toBe("Ephemera could not be reached");
    signIn.signedOut();
    expect(notReached(signIn.store.getState().phase)).toBe(
      "you're signed out; sign in, then try again",
    );
  });
});
