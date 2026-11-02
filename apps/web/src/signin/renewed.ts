import "../styles.css";
import { identity } from "./identity.ts";
import { RENEWAL_CHANNEL, RENEWAL_MESSAGE } from "./renewal.ts";

/*
 * The renewal page's script: the session is back (SWAG only served this page
 * after Authelia let the window through), so tell every Ephemera tab, and as
 * whom, and close. A window that cannot close keeps the page's own text.
 */
const user = identity.bound();
const channel = new BroadcastChannel(RENEWAL_CHANNEL);
channel.postMessage(user === undefined ? RENEWAL_MESSAGE : { ...RENEWAL_MESSAGE, user });
channel.close();
window.close();
