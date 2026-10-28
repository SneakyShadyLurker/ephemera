import { z } from "zod";

/** The Authelia username SWAG passes on every request. */
export const USER_HEADER = "Remote-User";

/** The username the client learned at load; a request bound to another user is refused. */
export const BOUND_USER_HEADER = "X-Ephemera-User";

/** The `dataset` key of the `<html>` attribute that names the page's user (shell.ts). */
export const USER_DATASET_KEY = "user";
export const USER_ATTRIBUTE = `data-${USER_DATASET_KEY}`;

/**
 * An admitted username, which is also the name of the user's data folder:
 * lowercase ASCII letters and digits, then `.`, `_` or `-`, at most 64
 * characters, so it can never be a path separator, `..` or a hidden name.
 */
export const usernameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
  .brand<"Username">();

export type Username = z.infer<typeof usernameSchema>;
