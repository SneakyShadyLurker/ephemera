import { z } from "zod";
import { createStore } from "zustand/vanilla";
import { type Identity, IdentityChanged, identity } from "./identity.ts";
import { RENEWAL_CHANNEL, RENEWAL_MESSAGE, RENEWAL_PAGE } from "./renewal.ts";

/*
 * The tab's view of its Authelia session (PRINCIPLES.md 2). Tab memory only:
 * nothing here is stored, and nothing about the chat is in it. The renewal
 * page announces itself on a BroadcastChannel, which the tab listens to only
 * while signed out; a renewal as another user ends the tab's life as this one.
 */

/**
 * Thrown for any API request that the sign-in redirect answered instead of
 * Ephemera. `stale`: the request was sent before the last renewal began, so
 * the refusal says nothing about the session now and its owner may retry.
 */
export class SignedOut extends Error {
  override name = "SignedOut";
  readonly stale: boolean;
  constructor(stale = false) {
    super("Signed out");
    this.stale = stale;
  }
}

/** A refusal that means the session is gone now, not one of an older request. */
export const signedOutNow = (error: unknown) => error instanceof SignedOut && !error.stale;

/**
 * Why a request the owner made got no answer: the one sentence every action
 * uses, so a signed-out failure never blames the server.
 */
export function notReached(phase: SignInPhase = signIn.store.getState().phase): string {
  return isSignedInPhase(phase)
    ? "Ephemera could not be reached"
    : "you're signed out; sign in, then try again";
}

/** A failed request worth retrying: never one that needs a sign-in first, nor another user. */
export const retryable = (error: unknown) =>
  !signedOutNow(error) && !(error instanceof IdentityChanged);

/** Where the tab stands with its Authelia session. */
export type SignInPhase = "active" | "expired" | "waiting" | "renewed" | "still-expired";

/** Whether a phase is signed in: requests may start. */
export const isSignedInPhase = (phase: SignInPhase): boolean =>
  phase === "active" || phase === "renewed";

/** What a renewal resumed, for the notice: a message, edits, or nothing in particular. */
type Resumed = "send" | "edits" | "nothing";

/**
 * How long a renewal waits for the owners it resumes before the tab counts as
 * signed in again; a stalled refetch then finishes, or fails, on its own.
 */
export const RENEWAL_PASS_MS = 15_000;

/** The renewal page's message: the username it loaded with, absent when the page carried none. */
const renewalMessageSchema = z.strictObject({
  type: z.literal(RENEWAL_MESSAGE.type),
  user: z.string().optional(),
});

interface Channel {
  listen: (handler: (data: unknown) => void) => void;
  close: () => void;
}

interface SignInDeps {
  /** Opens the renewal page in a new window with no opener. */
  open: (url: string) => void;
  channel: () => Channel;
  /** The user the tab serves; a renewal as anyone else goes to `changed`. */
  identity: Pick<Identity, "bound" | "changed">;
}

interface SignInState {
  phase: SignInPhase;
  /** What the last renewal resumed. */
  resumed: Resumed;
  /** Sheets whose edits wait for a session. */
  edits: number;
  /** Advances with every renewal, so images that failed while signed out load again. */
  renewals: number;
}

/** Resumes one owner's work; it may say what it resumed (a `Resumed`), anything else counts as nothing. */
type Listener = () => unknown;

/**
 * When a listener runs in the renewal: "save" (edits, settings, refetches)
 * first, then "resume" (the waiting generation), so a generation is built
 * from the entities as the owner left them.
 */
type RenewalStage = "save" | "resume";

const SIGNED_IN: SignInState = { phase: "active", resumed: "nothing", edits: 0, renewals: 0 };

export function createSignIn(deps: SignInDeps) {
  const store = createStore<SignInState>()(() => SIGNED_IN);
  const listeners: Record<RenewalStage, Set<Listener>> = { save: new Set(), resume: new Set() };
  let channel: Channel | undefined;
  /** Advances each time the tab goes from signed in to signed out. */
  let outage = 0;
  let resuming = false;
  /** Advances with each renewal pass; a request carries the pass it started in. */
  let pass = 0;
  /** Set when a request sent during the renewal's work is refused again. */
  let refusedAgain = false;
  /** Whether the current pass's save stage has ended. */
  let savesDone = true;

  const signedIn = () => isSignedInPhase(store.getState().phase);

  function listen() {
    if (channel !== undefined) return;
    channel = deps.channel();
    channel.listen((data) => {
      const message = renewalMessageSchema.safeParse(data);
      if (!message.success) return;
      // The session came back as someone else: nothing of this user's resumes.
      if (message.data.user !== deps.identity.bound()) {
        stopListening();
        deps.identity.changed();
        return;
      }
      void renewed();
    });
  }

  function stopListening() {
    channel?.close();
    channel = undefined;
  }

  async function renewed(): Promise<void> {
    if (signedIn() || resuming) return;
    stopListening();
    resuming = true;
    const current = ++pass;
    refusedAgain = false;
    savesDone = false;
    const done: unknown[] = [];
    const stage = (name: RenewalStage) =>
      Promise.allSettled(
        [...listeners[name]].map(async (listener) => {
          done.push(await listener());
        }),
      );
    // The generation waits for the saves, even past the bound, and never resumes into a newer
    // renewal or an expiry that came since.
    const work = stage("save").then(() => {
      if (pass !== current) return;
      savesDone = true;
      if (resuming || signedIn()) return stage("resume");
    });
    let bound: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work,
      new Promise((resolve) => {
        bound = setTimeout(resolve, RENEWAL_PASS_MS);
      }),
    ]);
    clearTimeout(bound);
    resuming = false;
    const resumed: Resumed = done.includes("send")
      ? "send"
      : done.includes("edits")
        ? "edits"
        : "nothing";
    if (refusedAgain) listen();
    store.setState((state) => ({
      phase: refusedAgain ? "still-expired" : "renewed",
      resumed,
      renewals: state.renewals + 1,
    }));
  }

  return {
    store,
    /** Whether the tab is signed in now. */
    signedIn,
    /**
     * A request was answered by the sign-in redirect. Only a request sent
     * since the last renewal began counts: an older one's late refusal says
     * nothing about the session now, during that renewal or after it.
     * Returns whether the refusal counted.
     */
    signedOut(startedIn: number = pass): boolean {
      if (startedIn !== pass) return false;
      if (resuming) {
        refusedAgain = true;
        return true;
      }
      if (!signedIn()) return true;
      outage++;
      store.setState({ phase: "expired" });
      listen();
      return true;
    },
    /** Whether the last renewal's saves have ended, so a waiting generation may go out. */
    savesSettled: () => savesDone,
    /** The owner chose Sign in: the renewal page opens in a new window. */
    signIn() {
      deps.open(RENEWAL_PAGE);
      store.setState({ phase: "waiting" });
    },
    renewed,
    /** The renewal pass a request starts in. */
    pass: () => pass,
    /** The outage a request starts in, or null while signed in. */
    outage: (): number | null => (signedIn() ? null : outage),
    /** A request started during `started`'s outage succeeded: the session is back. */
    confirmed(started: number | null) {
      if (started !== null && started === outage && !signedIn()) void renewed();
    },
    /** The renewed notice has been read. */
    dismiss() {
      if (store.getState().phase === "renewed") store.setState({ phase: "active" });
    },
    /** Resumes work after each renewal; returns the unsubscribe. */
    onRenewed(listener: Listener, stage: RenewalStage = "save"): () => void {
      listeners[stage].add(listener);
      return () => listeners[stage].delete(listener);
    },
    /** A sheet's edits wait for a session; the returned release is idempotent. */
    holdEdits(): () => void {
      store.setState((state) => ({ edits: state.edits + 1 }));
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        store.setState((state) => ({ edits: state.edits - 1 }));
      };
    },
    /** Back to signed in with no channel (tests). */
    reset() {
      stopListening();
      resuming = false;
      store.setState(SIGNED_IN);
    },
  };
}

/** The tab's one sign-in owner. */
export const signIn = createSignIn({
  open: (url) => {
    window.open(url, "_blank", "noopener");
  },
  channel: () => {
    const channel = new BroadcastChannel(RENEWAL_CHANNEL);
    return {
      listen: (handler) => {
        channel.onmessage = (event) => handler(event.data);
      },
      close: () => channel.close(),
    };
  },
  identity,
});
