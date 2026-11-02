/*
 * The renewal handshake, shared by the chat tab and the renewal page: one
 * channel name, one page, one fixed message that carries only the username
 * the page loaded with, so the tab knows whose session came back.
 */

export const RENEWAL_CHANNEL = "ephemera-signin";
/** Where Authelia sends the sign-in window back to; it announces the renewal and closes. */
export const RENEWAL_PAGE = "/auth/renewed";
export const RENEWAL_MESSAGE = { type: "renewed" } as const;
