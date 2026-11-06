/** A presentation handoff to the mounted composer. No consumer means no request is kept. */
export interface NewChatArrival {
  epoch: number;
  characterId: string | null;
}

let consumer: ((arrival: NewChatArrival) => void) | undefined;

export function registerNewChatFocus(callback: (arrival: NewChatArrival) => void) {
  consumer = callback;
  return () => {
    if (consumer === callback) consumer = undefined;
  };
}

export function focusNewChat(arrival: NewChatArrival) {
  consumer?.(arrival);
}
